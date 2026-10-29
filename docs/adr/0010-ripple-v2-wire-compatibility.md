# ADR-0010: Ripple Data API v2 wire compatibility, and every deliberate deviation

**Status:** Accepted. Amended seven times: Amendment 1 (2026-10-19), by [ADR-0012](0012-validators-and-amendments-data.md), the validators routes and the amendments routes (the amendment at the end of this record, items 40 to 48); Amendment 2 (2026-10-19), by [ADR-0013](0013-account-and-market-aggregates.md), the routes and parameters of the account and market aggregates (section 2, items 10a to 10g); Amendment 3, by [ADR-0011](0011-amm-data-and-swaps-as-exchanges.md), AMM swaps are exchanges (section 6, items 49 to 53); Amendment 4 (2026-10-24), by [ADR-0014](0014-address-names-and-labels-in-a-shared-database.md) and [ADR-0015](0015-historical-account-state-from-clickhouse.md), the account investigation data of spec #4 (the amendment at the end of this record, items 54 to 63, 65 to 72); Amendment 5 (2026-10-24), by [ADR-0016](0016-nft-and-uritoken-data.md), the NFT and URIToken routes, the `coverage` field and `nft_volume` (the amendment at the end of this record, items 73 to 78); Amendment 6 (2026-10-24), by [ADR-0017](0017-display-names.md), the account names and toml routes (the amendment at the end of this record, items 79 to 83); Amendment 7 (2026-10-24), by [ADR-0018](0018-ledger-object-history.md), the routes of the ledger objects and delegations, the `delegate` column of the account transactions CSV and the fee of a delegated transaction (the amendment at the end of this record, items 84 to 93). Items 7 and 10 were edited in place on 2026-10-29, each to point at Amendment 7 (the routes and the table it adds are not the ones those items dropped), and item 54 gained the column `delegate` on the same day. Item 44 gained one sentence on 2026-10-24, for the fixed validator list of Xahau Testnet ([ADR-0012](0012-validators-and-amendments-data.md#amendment-2026-10-24-the-testnets)).

## Context
The goal of this service is to be a **drop-in replacement for `data.ripple.com`** (the `rippled-historical-database` project, Ripple Data
API v2) for the XRP Ledger and for Xahau: a client written for the original must work by changing its host and sending an API key. The original's
README and its code disagree in places, and its code has outright bugs (requests that hang, CSV that crashes, stale whitelists, ignored
filters). The contract has to be pinned down, and so does every place where this service answers something else than the original did.

## Decision
**The fidelity rule.** Match what `data.ripple.com` **actually served** (the behaviour of its code and of the rows its database returned), not
what its README says. Reproduce paths, parameters, defaults and maximums, validation order, **exact error messages**, field names and types,
and **key order** (the original's JSON order is the order its database returned columns in: the `d` family sorted by name, then the `f`
family sorted by name; the same order is kept in CSV columns). **Outright bugs are fixed**, and every fix and every other deviation is listed
below. Where a ruling made during implementation changed served behaviour it is in this list; the endpoint-by-endpoint wording is in
[api-reference](../api-reference.md) ("Differences from data.ripple.com").

- Errors are `{"result":"error","message":"<the original's text>"}` with 400/404/500; unknown query parameters are ignored; a repeated
  parameter takes its first value; a 5xx is the route's own failure message and never carries the cause.
- Parsing is hand-written (`common/params.ts`): booleans match `/true/i` (`strict` is false only on `/false/i`, `include_exchanges` is true for any
  non-empty value), dates are the original's formats, `end` is inclusive at its own granularity.
- Everything is checked against the original's own tests: the mocha suites of the original (`test.ledgers.js`, `test.payments.js`, ...)
  were ported as parity tests, run against the mock ledgers the original shipped.

## Deliberate deviations

### 1. Access and deployment (not in the original)
1. **An API key is required** on `/v2/*` (`X-API-Key` or `Authorization: Bearer`), 401 `Missing or invalid API key.` This is the one deliberate
   break of the wire contract. Boot fails in production without keys or with the placeholder keys (`dev-api-key`, `change-me...`).
2. **One host per network** (`xrpl.data.<domain>`, `xahau.data.<domain>`); the same `/v2/...` paths on both ([ADR-0009](0009-one-deployment-per-network.md)).
   The native currency is `XRP` or `XAH`; "no issuer" means the native currency of the network.
3. **Rate limiting** keeps the original's 429 wording (`Rate limit exceeded, retry in N.NNsec`, two decimals) with `Retry-After` and `X-RateLimit-*`
   headers; `X-RateLimit-Reset` is a delta in seconds (the original sent an absolute time). Default 600 per 60 s per client address and route.
4. **Markers** are opaque base64url keys of the last row, not HBase row keys ([ADR-0007](0007-ledger-index-axis-and-secondary-tables.md)); the `Link`
   header keeps reserved characters percent-encoded (the original decoded everything and produced unfollowable links); a malformed marker is 400.
5. **`GH_*` configuration, `/internal/docs`, `/liveliness/healthz`, `/metricz`** are ours.

4a. **CSV flattening is applied on every route that has a CSV form.** The original flattened nested objects (its `flattenJSON` helper) on only 9 of its 29
    routes and printed `[Object]` in the cells of the others, which made those files unusable. The other conventions of its CSV writer (`nice-json2csv`:
    union-of-keys header in order of first appearance, every cell quoted, `\"` escaping) are kept. See [api-reference](../api-reference.md#csv).

### 2. Endpoints kept, added, dropped
6. **Kept as extras:** `GET /v2/exchanges` (the exchanges of all pairs) and `GET /v2/last_validated` (the original had it, its README did not list it).
7. **Not served (out of scope).** The original's `api/server.js` served more than the endpoint set this API was asked to implement. These routes are **not part of this
   API and answer 404**: `/v2/health[/{aspect}]`; `/v2/gateways[/{gateway}]` and `/v2/gateways/{gateway}/assets[/{filename}]`; `/v2/currencies[/{currencyAsset}]`;
   `/v2/network/{external_markets, xrp_distribution, top_markets[/{date}], top\_currencies[/{date}], topology, topology/nodes[/{pubkey}], topology/links,
   validators[/{pubkey}[/manifests|/reports]], validator_reports, rippled_versions}`; `/v2/accounts/{address}/{escrows, payment_channels}`; `/v2/reports[/{date}]`;
   `/v2/maintenance/{domain}`; `/v2/estimate`; and the API map at `/` and `/v2`, whose index also appeared as the `api-map` key of the original's 404 body (here the
   404 body is `{result, message}` only). The old GateHub `/v2/ledgers` time-range list is dropped as well (it collided with Ripple's "latest ledger": `/v2/ledgers`
   without an identifier is the latest ledger). Dropping the escrows and payment-channels *routes* goes with dropping their tables (item 10). Amendment 7 (items 84 to 93) serves the escrows, checks and payment channels *by object ID* from a table of another kind; these two account lists stay 404.
8. **`/v2/ledger/{hash}/validations[/{pubkey}]`** (singular) is registered as an alias of `/v2/ledgers/{hash}/validations[/{pubkey}]`. It appears only in the
   original's README, not in the route table of either branch's `server.js`; it is provided because the README documented it and it was asked for.
9. **`minute` live period of the volume routes is not supported** (the original's develop branch had it); `hour, day` (payments) and `hour, day,
   3day, 7day, 30day` (trades) are. The historical mode (`start`/`end`/`interval=day|week|month`) of the develop branch is implemented.
10. **Data dropped:** the offers, issuers, escrows and paychannels tables and parsers. Escrow and payment-channel *typing* stays in `balance_changes`. (Amendment 7 adds the history of escrows, checks, payment channels and delegations in `object_changes`, a ledger table of its own, and `escrows`, an aggregate for D7's total: neither is the original's table.)
    `accounts_created.genesis_*` stays empty until a history import loads ledger 32570.

**Amendment 2 (2026-10-19), added by the account and market aggregates ([ADR-0013](0013-account-and-market-aggregates.md)); the wording is in [api-reference](../api-reference.md#account-analytics-get-v2accountsaddressanalytics):**
10a. **New routes (extras, not in the original):** `/v2/accounts/{address}/analytics/{balances, balance_changes, counterparties, exchanges}` and `/v2/network/markets`. Their object shapes
    and key orders are ours, pinned by tests, and none serves an AMM field (until 10g: `network/markets` does, from the AMM data additions; the analytics routes never do).
10b. **New parameters on routes of the original:** `interval` (`day`, `week`, `month`) on `/v2/accounts/{address}/stats/{family}` and on `/v2/accounts/{address}/reports`. Without it the answers are the
    original's. Before this change an `interval` there was ignored like any unknown parameter, so **a client that sent one now gets buckets**. With `interval`, `stats/value` has a row for every bucket from the first one in which
    the account had a balance up to the bucket that holds now, not only for active ones; `reports` allows 200 buckets of the interval (200 days, weeks or months; 200 months is all of the history), `payments=true` stays per day (400 `payments can only be listed with interval day`
    with a week or a month), and the counterparties of a bucket are counted over the whole bucket.
10c. **Markets:** `network/markets` lists every pair that traded, not a configured list; its windows start on the hour (those of the live volumes are exact); the native volume of a pair goes through the window's rate of any native pair
    (`exchange_volume` takes only the configured native markets); prices are in the canonical stored orientation. `network/exchange_volume` is unchanged, so for a configured market the two routes can differ.
10d. **Analytics windows are whole UTC days, `end` included** (as `reports`), unlike the exclusive `end` of `stats/{family}`; with an `interval` they widen to whole buckets, at most 1000.
10e. **Valuing balance changes:** a change on a line the account owes on (its balance is below 0) is valued as the account's own IOU; LP tokens and assets without a DEX rate are worth 0, as in `stats/value` and `reports`.
10f. **Unclassified balance changes** (those of transaction types the original never classified) are a group without a `change_type` key in `analytics/balance_changes`, as the `balance_changes` objects leave it out.
10g. **AMM data additions to these aggregates** ([ADR-0013, D2b](0013-account-and-market-aggregates.md#d2b-the-amm-data-additions)): `network/markets` takes `amm` (`include`, `exclude`, `only`) and serves `amm` (the filter, after `period`),
    `amm_share` and `amm_pool` per market and `amm_share` in the totals, only when every ledger of the window was parsed with AMM support; the live day row of `network/amm_volume` (a route of ours) has `fees_est`, per component and on the row; the
    daily history of a pool has `computed_start` and `computed_end`. Wording in [api-reference](../api-reference.md#get-v2networkmarkets).

### 3. Outright bugs fixed
**Ledgers / transactions**
11. Empty database: `last_validated` answers 500 `unavailable` (the original never answered).
12. `ledger_hash` in the query is upper-cased (the raw text never matched the upper-case key). A `0x` prefix: the original's check could never match it;
    transaction hashes with `0x` are `invalid hash`, ledger hashes pass the test and find nothing (kept).
13. A ledger whose stored transactions are fewer than its `tx_count` is a 500 (also for the hash list), not a silently short answer. A date that carries
    milliseconds includes its own second. A non-numeric `ledger_index` query is 404 `ledger not found`. A missing `close_flags` is served as `"0"`.
14. `type` and `result` filters are validated against the **network definitions** (fetched from the node with a bundled per-network fallback), not the
    original's stale lists of 8 types and 32 results; Xahau types work on Xahau. A missing `end` is open-ended (the original used the time of the request).
15. `tx`/`meta` are served in the canonical form `decode(encode(stored))` with the network's definitions, as the original (which stored binary) did; a
    transaction the codec cannot serialize is served as its stored JSON and counted (`api_tx_encode_fallback_total`) instead of failing the page.

**Payments / accounts**
16. `/v2/payments/XRP+rIssuer` is 400 (was an empty search); `/v2/payments/+rIssuer` is 400 `currency is required` (was all payments).
17. A tag of `0` is kept and filterable (the original dropped a falsy tag, losing real routing tags).
18. The payments CSV file name is built from the request; the original's formula produced `payments  .csv`. The response has no top-level
    `currency`/`issuer` (the original's route read them from a result that never had them).
19. `limit` at or below 0 or not a number gives the default (it reached HBase as given), and pair/filter routes validate issuer addresses (the original
    answered an empty 200).
20. `/v2/accounts/{a}` answers with the **latest** creation of an address (the original with the earliest); a transaction that creates several accounts
    lists them all.
21. `max_sequence` is inclusive (the HBase stop row dropped it), and so is `min_sequence` when the list is descending (the reversed scan dropped that one); a reversed `min_sequence`/`max_sequence` is swapped (the original's behaviour, kept);
    sequences beyond what a sequence can be never become database errors.
22. Account payments honour `issuer`; account exchanges `/{base}[/{counter}]` work in either orientation (the original compared with the stored order
    literally), inverting what was stored the other way round; the account-exchanges CSV carries all 20 columns of every row (the original rewrote only the first).
23. Balance changes: the `change_type`/`type` filter accepts the five escrow/payment-channel types the rows carry (the original rejected them); no
    `paychannel_balance_change` (the original computed it but never stored it, so it was never served); no fee row for a fee of 0 (Batch inner
    transactions); AMM pool balance changes are ordinary balance changes; RippleState changes are produced for every transaction type.
24. `balances` / `orders`: the default ledger is the newest **validated** (the original asked for the open ledger); `ledger_hash` is honoured (was ignored);
    `direction` is `sell` when the offer has the sell flag (the original hard-coded `buy`); account_lines are paged until the limit is filled with lines
    that pass the filters (the original sliced then filtered, and subtracted the page size twice); `limit=all` pages to completion on both routes; orders
    validate the address (the original let the node fail with a 500); a date older than the first stored ledger is 400 `the date provided is too old`
    (was 500); a `ledger_hash` that is not 64 hex digits is 400 `invalid ledger hash` (the original had no such message: it ignored the hash); a repeated node
    marker is an error instead of an endless loop. The original's `currency` on orders was never used and is ignored.

**Exchanges / rates / volumes**
25. Aggregates (candles, `reduce`, active accounts) are **exact sums** of the stored decimal text, and amounts are served as exact text (the original summed
    `parseFloat`s and served texts like `50.00000000000001`). Inverted rates are computed with 200 decimal places (the default 20 zeroes the inverse of a rate
    above 10^12). Trades with an underivable rate (a zero leg) or MPT amounts are skipped, not stored as `NaN`/`Infinity`.
26. An invalid `interval` is 400 whatever the `limit` (the original skipped the check above 400 and failed with 500); `autobridged=true` works with candles (the
    original's filtered on a non-existent column); inverted candles compute `buy_volume` from the inverted trades; `reduce` covers the whole window, ignores
    `limit`/`marker`, and writes the window's start (the original reduced one page and wrote the time of the request); the native-leg dust filter is `<= 0.0005`
    in both paths; the CSV of candles/reduce keeps `buy_volume` on every row.
27. `exchange_rates`/`normalize`: an unparseable or empty `date` is 400 (was a 500); the same asset with a `period` is `1` (was `0`); `normalize` failures are
    HTTP 500 (the original answered the error body with 200); a non-finite `amount` is 400. `period` is a direct rolling window ending at `date` and the daily part
    runs from 00:00 of the day to `date` (the original summed pre-aggregated buckets); a month/year `date` reads the first calendar day of the period.
28. `active_accounts`: database failures answer 500 (the original hung); `format=csv` works; an empty `date=` is no date. The original's window rule (the end is one unit of the
    date's granularity past the period) and its counting of dust legs and self-trades are kept.
29. **Volume component `rate` semantics:** `rate` is how many units of the component's currency one native coin buys (`amount / converted_amount`); the original's
    non-native trade component carried the pair's vwap, for which `converted_amount = amount / rate` did not hold. `converted_amount` is always a string.
    Historical rows carry `end_time` (the start of the next bucket, exclusive). A day is final only once the ingest has passed it by an hour.
30. `reports` use the **UTC-day rate** of each issued currency instead of the rate at each payment's time (an accepted approximation); a window with a time of day yields
    the days of the calendar, not zero rows; quotients are cut to 17 significant digits and sums are exact.

**Network / validations / stats**
31. `fees` / `fee_stats` follow the served rows: key order `avg, max, min, total, tx_count, date, ledger_index` and `current_ledger_size, current_queue_size, date,
    expected_ledger_size, median_fee, minimum_fee, open_ledger_fee, pct_max_queue_size` (**not** the order of the design spec); the interval error is the short
    `invalid interval` (the long `use: ...` text belongs to the volume routes); `avg` is `toPrecision(6)` of total/tx_count rounded to a drop per ledger and total/tx_count
    rounded to a drop for buckets; a bucket's `min` does not depend on an empty first ledger; an empty bucket has `avg` 0 (was `NaN`); `fee_stats` with an interval serves
    the first snapshot at or after each boundary (the original needed a row stored at that exact second); `interval=raw` returns raw rows; ascending and descending lists
    sample the same boundaries (the original's two directions picked different ones).
32. **Validations are kept per (ledger, validator), not per reporting node.** A validation two collector nodes saw is one row whose `count` adds up; the original's data
    mixed both shapes. Values are the original's HBase text (flags, `ledger_index`, `signing_time`, fees, `full: "true"`; `count` is a number; empty columns absent),
    keys sorted alphabetically; a `0x` ledger hash works (was upper-cased to `0X...`); `limit` at or below 0 is the default; 404 `validation not found`.
33. `stats`: an `interval` other than hour/day/week is 400 `invalid interval`; exact messages including `invalid family, use: type, result, metric`; week = Monday to
    Sunday, UTC; zeros are left out.
34. **Account stats** (`/accounts/{a}/stats/{transactions,value}`): the original computed them in an external job that is not in its repository. Semantics are
    this service's reading of its README: `transaction_count` = transactions **sent** by the account, `balance_change_count` excludes fee rows, a negative issued balance
    (what the account owes) is worth 0, `account_value` is always a string, `end` is an exclusive instant.

### 4. Where the code serves the original's *actual* types
35. Ledger fields keep the types HBase served: numbers for `ledger_index`, `close_time`, `parent_close_time`; strings for everything else, including
    `close_time_resolution` (`"10"`), `close_flags` (`"0"`) and `last_validated.ledger_index`. Ledgers also carry the raw-ledger leftovers the original served
    (`hash, seqNum, totalCoins, accepted, closed`). A date identifier resolves to the last ledger closed within the period the text names.
36. The partial-payment `delivered_amount` rule falls back to `Amount` for the parser's payment row exactly as the original's parser did, while `meta.delivered_amount`
    of a transaction object still says `unavailable` for a pre-fix partial payment.

### 5. Closed in the final review (were known gaps)
The three gaps this section listed were fixed in the final fix round; they are kept here with what is served now.
37. A sub-second `start` is truncated to its second when resolved to a ledger, as the original's row keys were (Ruling R54); it was rounded up before.
38. A malformed percent escape in a path parameter (`/v2/accounts/%zz/payments`) answers the Ripple shape, `400 {"result":"error","message":"Failed to decode param '%zz'"}`
    (the text Express gives the error, naming the segment; Ruling R55); it was the toolbox's `{"error":{...}}` shape before.
39. The live routes `/balances` and `/orders` send `Cache-Control: private, max-age=<GH_LIVE_CACHE_TTL_MS in whole seconds>` (`no-store` when the live cache is off), and
    `limit=all` pages the node within an overall deadline of 30 s, past which the route answers its 500 (Ruling R108). Every other `/v2` answer carries the global
    `GH_CACHE_CONTROL`, now `private, max-age=60` by default (Ruling R109).

### 6. AMM swaps are exchanges (ADR-0011)
The original predates automated market makers. A swap against an AMM pool is stored as an exchange ([ADR-0011](0011-amm-data-and-swaps-as-exchanges.md)),
so these items differ from `data.ripple.com` on the XRP Ledger. Xahau has no AMM and is unaffected.
49. **Exchange-based endpoints include AMM swaps:** `/v2/exchanges/{base}/{counter}` (raw trades, candles and `reduce`), `/v2/exchanges`,
    `/v2/accounts/{address}/exchanges`, `/v2/exchange_rates`, `/v2/normalize`, `/v2/active_accounts`, `/v2/network/exchange_volume`, and the
    `exchanges_count` stored with each ledger (`ledgers.exchanges_count`), and so the one of `/v2/stats`. A swap is a trade between the two assets of the pool, with the pool as `provider`
    and as `seller` or `buyer`. The same applies to everything priced from the rates (account reports and value).
50. **The `amm` filter** (`include`, the default; `exclude`; `only`) is ours: the three exchange lists accept it, and anything else is 400
    `invalid amm filter - use: include, exclude, only`. `amm=exclude` gives the exchanges the original would have served.
51. **`amm_account` is the last key of an exchange object** (also of the exchanges of `active_accounts` with `include_exchanges`, and the last CSV
    column), present only on a swap. An order-book exchange is served byte for byte as before. A swap has `offer_sequence` 0.
52. **A swap's amounts are the pool's deltas.** On the asset the pool pays out they include the issuer's transfer fee (the book rows use the
    offer's change, which excludes it), and the `rate` follows from them.
53. **New endpoints (extras, not in the original):** `/v2/amm/pools[/{pool}|/{base}/{counter}]`, `/v2/amm/pools/{pool}/{history,swaps,liquidity,governance}`,
    `/v2/accounts/{address}/{amm_liquidity,amm_positions}` and `/v2/network/amm_volume`, in [api-reference](../api-reference.md#amm).

## Consequences
**Positive**
- A client of `data.ripple.com` works with a new host and an API key; the differences are enumerated, justified and tested.
- Bug fixes are visible, not silent: they are listed here and pinned by tests.

**Negative / trade-offs**
- Reproducing served behaviour reproduces oddities (string-typed ledger fields, copied failure messages such as `unable to retrieve payments` on the reports route).
- Markers, exact amounts and canonical transactions differ from the original in digits or tokens a client should not parse.
- The deviation list must be maintained: a new ruling that changes served behaviour adds a line here and to [api-reference](../api-reference.md).

## Amendment 1 (2026-10-19): the validators routes and the amendments routes
Item 7 above lists `/v2/network/validators[/{pubkey}[/manifests|/reports]]` among the routes of the original that answer 404. That has changed
([ADR-0012](0012-validators-and-amendments-data.md)): `GET /v2/network/validators` and `GET /v2/network/validators/{key}` are served, and so are the
routes the original had no counterpart of: `GET /v2/network/validators/summary`, `GET /v2/network/validators/{key}/validations` and
`GET /v2/network/amendments[/{name}]`. Of the validators routes, only `/v2/network/validators/{pubkey}/manifests`, `/v2/network/validators/{pubkey}/reports`,
`/v2/network/validator_reports` and `/v2/network/rippled_versions` still answer 404 `Cannot GET ...`. The original served `/v2/network/validators[/{pubkey}]` from its
own crawler (`api/routes/network/getValidators.js`, `topology.js`); this API serves them from the validations and validator lists it collects, and deliberately differs:

40. **`scope`.** The original listed only the validators whose last validation was less than 60 s old. Here `scope=unl` (the default) lists the trusted UNL, offline
    members included, and `scope=all` adds every validator seen in the last 24 hours.
41. **Paging.** The original had none. Here `limit` (200, at most 1000), `marker` and a `Link` header, as every list.
42. **Order.** The original sorted by chain, UNL first, 24 h score, domain, key. Here: validators with a domain first, alphabetically by domain, then by key (the board's
    order).
43. **Row.** The original's row was `{validation_public_key, domain, chain, current_index, agreement_1h, agreement_24h, partial, unl}`. Here the same keys in the same order,
    without `chain` (one network per deployment), then the new ones. The agreement objects keep `{missed, total, score, incomplete}` and add `partial`; `agreement_30d` is new.
44. **`unl`** was "on Ripple's main or altnet list". Here it is "on the trusted UNL of the configured publishers" (`GH_UNL_PUBLISHERS`), and `unl_lists` names the lists. `unl_lists` may name `local`, the fixed list of `GH_UNL_VALIDATORS`.
45. **`domain`** came from the original's own domain check. Here it is the domain of the validator's manifest, and `domain_verification` says whether the validator's
    `/.well-known/xrp-ledger.toml` (Xahau: `xahau.toml`) confirms it.
46. **Agreement** was counted against the ledgers the original's chain logic saw. Here it is counted against the indexed validated chain, over full validations only,
    and a ledger the collector did not see (fewer than quorum UNL validations recorded) is left out for everybody.
47. **`{key}`** is a master key (`nH...`), a signing key (`n9...`) or 66 hex digits, and a signing key answers with the validator it belongs to. Every validator the deployment
    has seen or has on a list answers, however long ago it was last seen.
48. **Caching.** The validators and amendments routes send their own `Cache-Control` while `GH_CACHE_CONTROL` is not empty: `private, max-age=30` for the list, the summary
    and one validator, `max-age=5` for the validations of a validator (`max-age=300` with a `marker`), `max-age=60` for the amendments.

Kept from the original: the messages `Validator not found` and `unable to retrieve validator(s)` and the CSV name `validators.csv`. New 400s exist for the new parameters
(`invalid scope`, `invalid publisher`, `invalid amendment`, `invalid search`, `invalid marker`, `invalid validator public key`). The endpoint-by-endpoint wording is in
[api-reference](../api-reference.md#validators-and-amendments).

## Amendment 4 (2026-10-24): account investigation data
The account investigation data (spec #4: account transactions export, account names and labels, account state history, path
payments, exports; the hard-to-reverse parts are [ADR-0014](0014-address-names-and-labels-in-a-shared-database.md) and
[ADR-0015](0015-historical-account-state-from-clickhouse.md)) adds routes, parameters and fields the original did not have. Each is an
addition: what the original served is served as before. Names and labels are served inline on `GET /v2/accounts/{address}` only.

54. **`format=csv` on `GET /v2/accounts/{address}/transactions`.** The original had no CSV for account transactions and ignored
    `format`. Here `format=csv` answers one summary row per transaction from the account's side (`hash, ledger_index, executed_time,
    tx_type, result, initiator, counterparty, amount, currency, issuer, fee, flags_changed, delegate`; the last column came with Amendment 7, item 90), in a file `<address> - transactions.csv`,
    with every parameter and the paging of the JSON list. The raw `tx` and `meta` are not in it: flattened, they would give a column per
    field of every type. The JSON answer is unchanged.
55. **`account_name`.** The original's `account_data` was `{account, parent, initial_balance, inception, ledger_index, tx_hash}` (and the
    genesis fields). Here the same keys in the same order, then `account_name`, the account name of the address, left out when it has
    none. It is the same on every network.
56. **Names are not activations.** A name is the operator's, not the ledger's: it is served from a copy the api loads every 60 s
    (`GH_NAMES_AND_LABELS_RELOAD_MS`), so a new or removed name shows within that time, and an address with a name but no activation
    on the network still answers 404 `Account not found`, as in the original.
57. **`account_labels`.** After `account_name` and `account_network_name` (item 58), `account_data` carries the labels the operator
    put on the address (`scam`, `spam`, `advisory`) as an object keyed by label, in that order:
    `{ "scam": { "description": "…", "source": "…", "url": "…" } }`, with `source` and `url` left out when empty, and the whole field
    left out when the address has no label. The original had no labels. They are the same on every network, load and reload with the
    names (60 s), and a label on an address without an activation on the network does not make it found (item 56).
58. **`account_network_name`.** After `account_name`, the account network name: the name the operator gave the account on this
    network only ("USD Issuer" on the XRP Ledger), kept in the network's own database (`account_network_names`, migration 009) with
    the rules of the account names and reloaded with them. It is served with or without an `account_name`, and left out when there is
    none; the other network's api never shows it.
59. **Account flags.** The original's `/v2/accounts/{address}` answered with the account's creation only. Here `flags=true` adds `flags` to
    `account_data`, after its other keys: one `true`/`false` per account flag the network names (the XRP Ledger's from its definitions,
    Xahau's from xahaud's source), named without the `lsf` prefix. With `date` (alias `close_time`), a numeric `ledger_index` (alias
    `ledger`) or `ledger_hash` they are read from the account state history, with the precedence of `/balances`, and `ledger_index` and
    `close_time` come before `account_data`; without one (or with `validated`, `closed`, `current`) from `account_info` on the live node,
    with its `ledger_index`. Without `flags=true` the route reads and answers exactly as before, whatever ledger parameters it is sent.
60. **Historical ledgers from ClickHouse.** A ledger named by a date, a number or a hash is a ledger this API holds. One it does not hold
    (a number or hash it has not stored, a date before its first ledger), and one the state history does not cover (at or below the
    newest ledger an older parser wrote), answers 400 `the date provided is too old`, the original's message for a ledger its node did not
    have. An account with no state at that ledger, or one deleted at or before it, answers 404 `account not found`, as the node does.
61. **`GET /v2/accounts/{address}/trustlines`.** The original had no trust line route: its `/balances` listed each line's balance
    only, from the node. Here the account's trust lines at a ledger, from the trust line state history, each from the account's side:
    `{ result, ledger_index, close_time, count, marker?, trustlines: [ { currency, counterparty, balance, limit, limit_peer, no_ripple,
    no_ripple_peer, authorized, peer_authorized, freeze, peer_freeze, quality_in, quality_out } ] }`, ordered and paged by
    (`counterparty`, `currency`) with `limit` (200, max 1000) and `marker`, filtered by `currency` and `counterparty`, and
    `format=csv` (`<address> - trustlines.csv`). Lines with a zero balance are listed, lines deleted at or before the ledger are not;
    an issuer's lines are its holders. The ledger parameters are those of `/balances`, with its precedence.
62. **The newest indexed ledger, never the node.** Where `/balances` reads the node's validated ledger when no ledger is named,
    `/trustlines` reads the newest ledger this API has indexed, and `validated`, `closed` and `current` name that ledger too: its
    markers then always belong to this API's data, and its pages never mix two sources. The answer always carries that ledger's
    `ledger_index` and `close_time`. A newest ledger the state history does not cover answers 400 `the date provided is too old`, like a
    named one (item 60).
63. **`/balances` at a historical ledger, from the state history.** The original (and this API before ADR-0015) asked the node for
    the balances at any ledger, which needs a full-history node. Here a ledger named by `ledger_hash`, `date` or a numeric
    `ledger_index` is read from the account and trust line state history, never from the node: the native balance is the account's
    state at the ledger, the trust lines those of `/trustlines` at the ledger. The answer keeps its shape, precedence, `currency`,
    `counterparty`, `limit` (200, max 400, or `all`), CSV and messages, with three differences: the trust lines are **ordered by
    (`counterparty`, `currency`)**, not in the node's order; the answer always carries the ledger's `close_time` (before, only a
    `date` gave one); and it is not in the live cache, so it carries the global `Cache-Control`, not the live one. The rules of
    item 60 apply: a ledger this API does not hold or the state history does not cover is 400 `the date provided is too old`, an
    account with no state at the ledger or deleted at or before it 404 `account not found`. No ledger named, `validated`, `closed`
    and `current` still read the node, as does every ledger of `/orders`.

Kept from the original: the JSON answers of the routes it had, their parameters and their messages (`Account not found` and `unable to get accounts`). No new message: with `flags=true` the 400s of `/balances` (`invalid date format`, `invalid ledger hash`, `the date provided is too old`) and its 404 `account not found` apply, and `/balances` at a historical ledger keeps its own; `/trustlines` answers the 400s of `/balances` and of the paged lists (`invalid ripple address`, `invalid date format`, `invalid ledger hash`, `invalid limit`, `invalid marker`, `the date provided is too old`), and 500 `unable to retrieve trustlines`. The endpoint-by-endpoint wording is in [api-reference](../api-reference.md#get-v2accountsaddresstransactions), [api-reference](../api-reference.md#get-v2accountsaddress), [api-reference](../api-reference.md#get-v2accountsaddressbalances) and [api-reference](../api-reference.md#get-v2accountsaddresstrustlines).

**Path payments** (items 65 to 67). The wording is in [api-reference](../api-reference.md#path-payments).

65. **`GET /v2/path_payments`.** The original had no list of path payments (GLOSSARY.md: a successful payment whose delivery used
    someone else's liquidity). Here the path payments of the network in a window: `start`, `end`, `descending`, `limit` (200, at most
    1000), `marker` and a `Link` header, as every list, and `format=csv` with the file `path payments.csv`. The row is
    `hash, ledger_index, executed_time, source, destination, delivered_amount, currency, issuer?, source_amount, source_currency,
    source_issuer?, offers_crossed, amm_pools, rippled_through`, the issuers absent for the native currency. In the CSV, `amm_pools`
    and `rippled_through` are one cell each with the accounts separated by a space, where the original's flattening would have made
    one column per position (`amm_pools[0]`, ...) that changes from page to page.
66. **Payments to oneself.** The original's payments left a payment to oneself out (a conversion, not a payment), and
    `/v2/payments`, `/v2/accounts/{address}/payments` and the payment volumes still do. A path payment to oneself (an arbitrage loop,
    or a conversion through an offer or a pool) is listed by `/v2/path_payments` and `/v2/accounts/{address}/path_payments`.
67. **`GET /v2/accounts/{address}/path_payments`.** The original had no list of an account's path payments. Here the path payments
    the account sent or received, with the parameters, the paging and the row of `/v2/path_payments` (item 65), and `format=csv` with
    the file `<address> - path payments.csv`. A payment to oneself is listed once. An account a payment only rippled through, a pool
    and the owner of an offer crossed do not list it: they are in the row, not its source or destination. As on the original's lists
    under an account, the address is not checked: one that is none has an empty list.

The messages of `/v2/path_payments` and `/v2/accounts/{address}/path_payments` are those of `/v2/payments` (`invalid start date
format`, `invalid end date format`, `invalid marker`), with the 500 `unable to retrieve path payments`.

**Exports** (items 68 to 72). The wording is in [api-reference](../api-reference.md#exports).

68. **Exports.** The original had no exports: a client walked the pages itself. Here `POST /v2/exports` with `{path, format}` queues
    an export of any list with a CSV form (`path` is the list's `/v2/…?…` path, a list over time names `start` and `end`) and answers
    202 `{result, id, status: "queued"}`; `GET /v2/exports/{id}` answers `{result, id, status, format, path, created, finished?,
    rows?, error?, url?}`. Both are routes of their own: no route of the original changes.
69. **An export is the list.** The file is made by the exporter of the network, which walks the list's own CSV pages through the
    api with its own API key, so the file is the CSV the route would give for the whole list in one page (one header, the columns
    of every row, in the order they first appear). The format is `csv`, or `pdf` (item 72).
70. **An export belongs to its API key.** Only the key that created a job sees it: any other key gets 404 `export not found`, as
    for an id that does not exist. The job keeps the SHA-256 of the key, never the key. A done job's `url` is a Google Cloud
    Storage link signed at each request and valid for 15 minutes; the job and its file are kept 7 days.
71. **Export limits.** An API key has at most 3 exports queued or running (`GH_EXPORT_MAX_JOBS_PER_KEY`): one more answers 429
    `{"result":"error","message":"too many exports in progress: at most 3 per API key"}`, the body of every error of these routes,
    not the rate limit's `{"error":…}` (a different limit, with no time to wait for). An export holds at most 1,000,000 rows as CSV
    and 10,000 as PDF (`GH_EXPORT_MAX_ROWS_CSV`, `_PDF`). Where the list counts its rows up front (the account transactions by
    time) an export above the cap answers 400 at once; any other export fails when its list passes the cap, with the same message
    as its `error`: `the list has more than <cap> rows, the most a CSV export holds: narrow the window` (for PDF, `... a PDF export
    holds: narrow the window or use CSV`).
72. **PDF exports.** The original had no PDF. Here `format: "pdf"` makes a document of the same walked list, rendered by the
    exporter with `pdfkit` (not GateHub's `pdf-generator`): landscape A4; a header with the list's file name, for an account's list
    the address with its account name, account network name and labels (read from `/v2/accounts/{address}` through the api, like
    the rows), then the network, the list's path, its window (or the ledger it is at), the ledgers its rows cover, the row count
    and when it was made; then a table of the columns chosen for the list (the first 8 of a list without a choice; the CSV keeps
    every column) and `Page n of m` on every page. Opening and closing balances are not in it.

The messages of the export routes are new: 400 `invalid path`, `path is not exportable`, `start and end are required`,
`invalid format`, `the list has more than <cap> rows, ...`; 404 `export not found`; 429 `too many exports in progress: at most 3
per API key`; 503 `exports are not available` (no bucket configured); 500 `unable to create the export` and `unable to retrieve
the export`.

## Amendment 5 (2026-10-24): NFTs and URITokens
The NFT and URIToken data (program 2, sub-project D3: [ADR-0016](0016-nft-and-uritoken-data.md), the wording in
[api-reference](../api-reference.md#nfts)) adds routes, a field and a volume metric the original did not have. Each is an addition: what the
original served is served as before.

73. **The NFT routes, as extras.** The original predates NFTs. Here `GET /v2/nfts/{nft_id}`, `GET /v2/nfts/{nft_id}/history`,
    `GET /v2/nfts/{nft_id}/offers`, `GET /v2/accounts/{address}/nfts`, `GET /v2/accounts/{address}/nft_history`, `GET /v2/nft_collections`,
    `GET /v2/nft_collections/{issuer}/{taxon}` (XRPL) and `GET /v2/nft_collections/{issuer}` (Xahau) with their sub-routes `/nfts`, `/holders`,
    `/sales` and `/stats`, and `GET /v2/nft_sales`. They serve the NFTokens of the XRP Ledger and the URITokens of Xahau (`kind` is `nftoken` or
    `uritoken`) with the contract of every list: `limit` (200, at most 1000), `marker` and a `Link` header, `format=csv`, absent keys left out.
    A key that does not exist for a kind is left out (`taxon`, `serial` and `transfer_fee` of a URIToken). The other network's id, or the other
    form of a collection's path, is 404 `nft not found` or `collection not found`.
74. **`coverage`.** Every answer of these routes carries `"coverage": { "from_ledger_index": N, "complete": bool }`, the key right after `result`
    (`from_ledger_index` is left out when no ledger is stored), and it is not in the CSV. It says whether the NFT history the answer is read
    from is whole: it starts at the first ledger written by the NFT parser (version 5) and is complete when that is at or before the ledger the
    feature starts at, the enable ledger of `NonFungibleTokensV1_1` (XRPL) or `URIToken` (Xahau, ledger 1). The detail, history and offers of an NFT
    state their own: complete when its mint is indexed. The rule is the program's one coverage rule ([api-reference](../api-reference.md#coverage),
    [ADR-0016](0016-nft-and-uritoken-data.md)); no existing route gained the field.
75. **`GET /v2/network/nft_volume`.** The route of `exchange_volume` (live and historical modes, `interval`, `exchange_currency` and
    `exchange_issuer`, `limit`, `marker`) for the sales of NFTs, in the native currency, a component per collection:
    `{issuer, taxon?, count, amount, rate, converted_amount}`. The live periods are `day`, `7day` and `30day` only (400 `invalid period - use:
    day, 7day, 30day`), so the live sets are fifteen in all. `amount` is the volume of the collection's sales that have a price in the native
    currency at that day's rate and `count` those sales; **the `count` of the row is every sale of the window**, those with no rate included. The
    amounts of this metric are exact decimals, and so are their sums (the other metrics add Float64 values). `coverage` follows `result`.
    CSV: `nft_volume.csv`. Its daily sets carry a config version of their own, so a change of the markets config does not recompute them.
76. **The CSV names.** `<nft_id> - nft history.csv`, `<address> - nfts.csv`, `<address> - nft history.csv`, `nft collections.csv`,
    `<issuer>[ <taxon>] - nfts.csv`, `<issuer>[ <taxon>] - holders.csv`, `<issuer>[ <taxon>] - sales.csv`, `<issuer>[ <taxon>] - stats.csv`,
    `nft sales.csv` and `nft_volume.csv`. The columns are the keys of the object in order, a nested object as `a.b`, an absent key an empty cell.
    Each route with a CSV form can be exported ([Exports](../api-reference.md#exports)); those over time (`history`, `nft_history`, a
    collection's `sales` and `stats`, `nft_sales`, `nft_volume`) name `start` and `end` in the export.
77. **Messages and checks.** The messages are new: 400 `invalid nft id`, `invalid taxon`, `invalid event`, `invalid role`, `invalid type`,
    `invalid sort`, `start is required` (the stats of a collection), `invalid window - use at most 366 days`; 404 `nft not found`, `collection
    not found`; 500 `unable to retrieve nft`, `unable to retrieve nft history`, `unable to retrieve offers`, `unable to retrieve nfts`,
    `unable to retrieve collections`, `unable to retrieve collection`, `unable to retrieve holders`, `unable to retrieve sales`, `unable to
    retrieve stats` and, for the volume, `error getting data`. The checks run in the order the parameters are listed, a bad marker is a 400
    before a 404, and **an empty `start=` or `end=` is 400** on the NFT routes (the volume keeps the contract of the other volumes: empty is none).
    A failed coverage read fails the route with its own 500, no `complete: false` is invented.
78. **Caching.** The NFT routes send the global `Cache-Control` (`private, max-age=60`); the list of all collections is kept 60 s in the api.

Kept: every route and message of the original. The endpoint-by-endpoint wording is in [api-reference](../api-reference.md#nfts) and
[api-reference](../api-reference.md#get-v2networknft_volume).

## Amendment 6 (2026-10-24): display names
The display names (program 2, sub-project D4: [ADR-0017](0017-display-names.md), the wording in
[api-reference](../api-reference.md#account-names-and-tomls)) add two routes the original did not have. Each is an addition: **no route of the original
changes**, and the fields `account_name`, `account_network_name` and `account_labels` of `GET /v2/accounts/{address}` are as before.

79. **`GET /v2/account_names`, as an extra.** The original predates names. Here `GET /v2/account_names?addresses=` answers `{result, count, account_names}`
    with one entry per address asked, **in the order asked**: `{address, display_name?, domain?, account_name?, account_network_name?, labels?}`, a key
    without a value left out and never `null`. `display_name` is `{text, kind}`, `kind` being `verified` (the toml of the account's domain lists the
    address), `account` (the operator's name, else its name on this network) or `domain` (a domain nothing vouches for); `domain` is the account's domain
    whatever its state. The parameter is 1 to 100 classic addresses separated by `,`, with no spaces and no trimming; a repeated address is answered at each
    place and counts towards the 100; an X-address is refused; the first of a repeated `addresses` wins. Any address is answered: one that is no account on
    the network keeps its name and labels and has no domain.
80. **`GET /v2/toml/{domain}`, as an extra.** What the toml of a domain says, as the `tomls` worker last stored it: `{result, toml}` with `domain, toml_url,
    status, reason?, status_code?, checked, fetched?, modified?, expires?, accounts?, currencies?, principals?, validators?`, only the entries that count on the
    network and only the keys the reference lists (a principal's email and social handles are never read; `[[SERVERS]]` and `[ORGANIZATION]` neither). The
    domain is lower-cased first. A failed check is a 200 with `status: "failed"`, not a 404. The api never fetches on a request.
81. **The key of the labels is `labels`.** The batch's entry says `labels` where `GET /v2/accounts/{address}` says `account_labels`; the object is the
    same (keyed `scam`, `spam`, `advisory`, each `description`, `source?`, `url?`).
82. **Messages and checks.** The messages are new: 400 `addresses is required`, `too many addresses - at most 100`, `invalid ripple address`, `invalid domain`;
    404 `toml not found`; 500 `unable to retrieve account names`, `unable to retrieve toml`. The checks run in this order: `addresses is required`, then
    `too many addresses - at most 100`, then `invalid ripple address`; a failed read of the account domains fails the batch with its 500, and no answer is
    made without them. Unknown parameters are ignored.
83. **No `coverage`, no CSV, the default cache.** Neither answer carries `coverage` (a lookup that lists nothing: [Coverage](../api-reference.md#coverage));
    neither has `limit`, `marker`, `Link` or a CSV form; both send the global `Cache-Control` (`private, max-age=60`) and errors `no-store`. An account
    whose Domain was set before the state history starts and has not changed since has no domain until it does ([backfill](../backfill.md#account-domains-seed)).

## Amendment 7 (2026-10-24): ledger objects and delegation
The ledger objects (program 2, sub-project D5: [ADR-0018](0018-ledger-object-history.md), the wording in
[api-reference](../api-reference.md#ledger-objects)) add nine routes the original did not have, change one column of an export and fix two bugs of the account
books. **No route of the original is removed or changes the shape of its answer**: the JSON list of account transactions is as before, and its CSV gains a column.

84. **Nine routes, as extras.** The original served no object of the ledger by its ID. Here `GET /v2/escrows/{escrow_id}`, `GET /v2/checks/{check_id}` and
    `GET /v2/payment_channels/{channel_id}`, each with `/history`; `GET /v2/accounts/{address}/escrows/{sequence}` (an escrow by its owner and the sequence of
    the transaction that created it, answered exactly as its ID is: the ID is worked out from the two, so no table is read first); `GET /v2/accounts/{address}/delegations`
    (the permission delegations an account gave or holds); and `GET /v2/ledger_objects/{object_id}` (which kind of object an ID is, so that a pasted ID finds its page).
    They are served on both networks.
85. **Shape.** Every answer but the lookup of an ID starts `result, coverage, ledger_index, close_time`: the `coverage` of its feature ([Coverage](../api-reference.md#coverage);
    an object's own is complete also when its creation is indexed), then the newest committed ledger and when it closed, which is the point the state and the `status` are
    as of. The key orders (`escrow_id, account, sequence?, destination, amount, ...`) are ours and are pinned by tests and by the reference's "Keys of" lines; a key with
    no value is left out, never `null`. IDs are 64 hex digits, accepted in any case and answered in upper case; times are `YYYY-MM-DDTHH:mm:ssZ`; the permission of a
    delegation is `{permission, kind, transaction_type?}`. An **amount** is `{currency, issuer?, value}`: the native currency's code without an issuer and the value in
    whole units, an issued token as on the ledger, and a multi-purpose token as `{currency: <48 hex digits of the issuance ID>, issuer, value: <raw integer units>,
    mpt_issuance_id}` (**the data API's MPT amount object**, which the later MPT routes serve every MPT amount in). The `status` is worked out at the close time of the
    answer: an escrow is `pending`, `can_be_finished` or `can_be_cancelled` and, once deleted, `finished`, `cancelled` or `removed`; a check `open`, `expired`, `cashed`,
    `cancelled` or `removed`; a payment channel `open`, `closing` (it has an `expiration`, or a `cancel_after` that has been reached, and any transaction on it closes it)
    or, once deleted, `closed` or `removed`.
86. **History and paging.** The detail of an object embeds its newest 50 events (newest first) and a `history_marker` when there are more, which continues at
    `/{id}/history?descending=true&marker=...`. The history routes take `descending` (default false: oldest first), `limit` (200, at most 1000), `marker`, `format=csv`
    (files `<id> - escrow history.csv`, `<id> - check history.csv`, `<id> - payment channel history.csv`; the same columns on every page, an amount's keys joined to its name
    with a dot) and send `Link`. An unknown parameter is ignored. A page past the end of an object that has events is `count: 0`; an object with none is 404.
87. **Delegations.** `direction` is `given` (default; the account is the delegating `account`) or `held` (it is the `authorize`); an empty `direction=` is `given`. Only the
    entries that are in the ledger are listed, ordered by `updated` (newest first) and then `delegation_id`, with `limit` (200, at most 1000), `marker`, `Link` and
    `format=csv` (files `<address> - delegations given.csv` and `<address> - delegations held.csv`; the permission names in one cell, separated by a space). An account with
    more than 10,000 delegations in the direction is a 500 `unable to retrieve delegations` that is logged: the list is a guard, not a page. **On Xahau, which has no
    permission delegation, the answer is an empty list with `complete: true`**, not a 404, and no table is read.
88. **Messages and checks.** The messages are new: 400 `invalid escrow id`, `invalid check id`, `invalid channel id`, `invalid ledger object id`, `invalid ripple address`
    and `invalid sequence number` (the messages of `GET /v2/accounts/{address}/transactions/{sequence}`; **the owner of an escrow by sequence is checked**, as it is part
    of the ID), `invalid direction`, `invalid marker`; 404 `escrow not found`, `check not found`, `payment channel not found`, `ledger object not found`; 500 `unable to retrieve
    escrow`, `escrow history`, `check`, `check history`, `payment channel`, `payment channel history`, `delegations`, `ledger object`. The checks run in the order the
    reference lists them (a bad marker is a 400 before a 404). A failed read of the coverage fails the route with its own 500, and no `complete: false` is invented. With no
    committed ledger the object routes answer their 404 and the delegations 500.
89. **No node fallback, and what 404 means.** The API serves what the index holds and never asks a node for an object. An object the index has no row of answers 404, which is
    also what an object created before the first ledger written by parser version 7 and untouched since gets; the `coverage` of the other routes says where the history starts
    ([backfill](../backfill.md#ledger-objects-and-delegation-re-ingest)). Escrows, checks and channels stay `complete: false` until the history backfill; delegation is complete
    after its re-ingest. The routes send the global `Cache-Control` (`private, max-age=60`) and errors `no-store`.
90. **`delegate` in the account transactions CSV.** The summary row of `GET /v2/accounts/{address}/transactions?format=csv` (item 54) gains `delegate` as its **last**
    column: the transaction's `Delegate`, empty when it has none, on the row of every account the transaction affected. `fee` is on the row of the account that paid it: the
    delegate's when the transaction names one, else the sender's. The JSON list is unchanged (its `tx` already carries `Delegate`), and so are the PDF columns of an
    export. A delegate always has the transaction in its own list, with `is_initiator` 0, also when the metadata names none of its accounts (a fee-free inner transaction of
    a Batch); `account_tx_by_sequence` stays the sender's.
91. **The fee of a delegated transaction is the delegate's (a fix).** Until parser version 7 the `transaction_cost` row of a delegated transaction was put on its
    `Account`, but the delegate signs it and pays its fee (the original predates permission delegation). From parser version 7 on the row is the delegate's and the sender's native row is its whole change, so the
    rule that, per currency, the changes of a transaction sum to zero but the fee burned holds for a delegated transaction. The same rule is applied to two columns that
    added the fee back to the source whoever paid it: `payments.source_balance_changes` and `path_payments.source_amount`. Everything derived from `balance_changes`
    (`/accounts/{address}/balance_changes`, the `stats` and `reports`, the analytics, the rollups) follows from a re-ingest of the ledgers (`range-ingest --reprocess` from
    ledger 107,524,865, [backfill](../backfill.md#ledger-objects-and-delegation-re-ingest)); ledgers before it keep the old rows, and a delegated transaction before the
    reprocess has no fee row on the delegate. A delegate that is also the destination of a delegated Payment (a sweep to itself) still has the fee taken out of its
    destination change in `payments.destination_balance_changes`; that column is corrected by a later fix of the program, and the re-ingest rewrites it.
92. **Issued-token payment channels are typed (a fix).** On Xahau (`PaychanAndEscrowForTokens`) a payment channel can hold an issued token, and the parser read every
    channel amount as drops: `dropsToNative` of a token's amount object throws a `LedgerParseError`, which halts the live syncer and fails a range chunk at the first such
    ledger. Channels are now typed in the currency they hold, as escrows are, and **a Xahau syncer halted on such a ledger resumes after the deploy**. One thing means
    something else than for a native channel: on Xahau the creator's line moves at each claim, so a claim's creator row is typed `paychannel_fund` with the claimed delta
    (the values match the ledger; the label does not say "funded").
93. **Kept: item 7.** `/v2/accounts/{address}/escrows` and `/v2/accounts/{address}/payment_channels`, the lists of the original, still answer 404 (the explorer's Objects
    tab reads an account's objects from the node). Items 7 and 10 stand, and say so, in place.

Kept: every route and message of the original. The endpoint-by-endpoint wording is in [api-reference](../api-reference.md#ledger-objects).
