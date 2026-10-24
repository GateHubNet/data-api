# ADR-0010: Ripple Data API v2 wire compatibility, and every deliberate deviation

**Status:** Accepted. Amended four times: Amendment 1 (2026-10-19), by [ADR-0012](0012-validators-and-amendments-data.md), the validators routes and the amendments routes (the amendment at the end of this record, items 40 to 48); Amendment 2 (2026-10-19), by [ADR-0013](0013-account-and-market-aggregates.md), the routes and parameters of the account and market aggregates (section 2, items 10a to 10g); Amendment 3, by [ADR-0011](0011-amm-data-and-swaps-as-exchanges.md), AMM swaps are exchanges (section 6, items 49 to 53); Amendment 4 (2026-10-24), by [ADR-0014](0014-address-names-and-labels-in-a-shared-database.md) and [ADR-0015](0015-historical-account-state-from-clickhouse.md), the account investigation data of spec #4 (the amendment at the end of this record, items 54 to 60, 65, 66, 68 to 70 and 72).

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
   without an identifier is the latest ledger). Dropping the escrows and payment-channels *routes* goes with dropping their tables (item 10).
8. **`/v2/ledger/{hash}/validations[/{pubkey}]`** (singular) is registered as an alias of `/v2/ledgers/{hash}/validations[/{pubkey}]`. It appears only in the
   original's README, not in the route table of either branch's `server.js`; it is provided because the README documented it and it was asked for.
9. **`minute` live period of the volume routes is not supported** (the original's develop branch had it); `hour, day` (payments) and `hour, day,
   3day, 7day, 30day` (trades) are. The historical mode (`start`/`end`/`interval=day|week|month`) of the develop branch is implemented.
10. **Data dropped:** the offers, issuers, escrows and paychannels tables and parsers. Escrow and payment-channel *typing* stays in `balance_changes`.
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
44. **`unl`** was "on Ripple's main or altnet list". Here it is "on the trusted UNL of the configured publishers" (`GH_UNL_PUBLISHERS`), and `unl_lists` names the lists.
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
    tx_type, result, initiator, counterparty, amount, currency, issuer, fee, flags_changed`), in a file `<address> - transactions.csv`,
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

Kept from the original: the JSON answers of the routes it had, their parameters and their messages (`Account not found` and `unable to get accounts`). No new message: with `flags=true` the 400s of `/balances` (`invalid date format`, `invalid ledger hash`, `the date provided is too old`) and its 404 `account not found` apply. The endpoint-by-endpoint wording is in [api-reference](../api-reference.md#get-v2accountsaddresstransactions) and [api-reference](../api-reference.md#get-v2accountsaddress).

**Path payments** (items 65 and 66). The wording is in [api-reference](../api-reference.md#path-payments).

65. **`GET /v2/path_payments`.** The original had no list of path payments (GLOSSARY.md: a successful payment whose delivery used
    someone else's liquidity). Here the path payments of the network in a window: `start`, `end`, `descending`, `limit` (200, at most
    1000), `marker` and a `Link` header, as every list, and `format=csv` with the file `path payments.csv`. The row is
    `hash, ledger_index, executed_time, source, destination, delivered_amount, currency, issuer?, source_amount, source_currency,
    source_issuer?, offers_crossed, amm_pools, rippled_through`, the issuers absent for the native currency. In the CSV, `amm_pools`
    and `rippled_through` are one cell each with the accounts separated by a space, where the original's flattening would have made
    one column per position (`amm_pools[0]`, ...) that changes from page to page.
66. **Payments to oneself.** The original's payments left a payment to oneself out (a conversion, not a payment), and
    `/v2/payments`, `/v2/accounts/{address}/payments` and the payment volumes still do. A path payment to oneself (an arbitrage loop,
    or a conversion through an offer or a pool) is listed by `/v2/path_payments`.

The messages of `/v2/path_payments` are those of `/v2/payments` (`invalid start date format`, `invalid end date format`,
`invalid marker`), with the 500 `unable to retrieve path payments`.

**Exports** (items 68 to 70 and 72). The wording is in [api-reference](../api-reference.md#exports).

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
72. **PDF exports.** The original had no PDF. Here `format: "pdf"` makes a document of the same walked list, rendered by the
    exporter with `pdfkit` (not GateHub's `pdf-generator`): landscape A4; a header with the list's file name, for an account's list
    the address with its account name, account network name and labels (read from `/v2/accounts/{address}` through the api, like
    the rows), then the network, the list's path, its window (or the ledger it is at), the ledgers its rows cover, the row count
    and when it was made; then a table of the columns chosen for the list (the first 8 of a list without a choice; the CSV keeps
    every column) and `Page n of m` on every page. Opening and closing balances are not in it.

The messages of the export routes are new: 400 `invalid path`, `path is not exportable`, `start and end are required`,
`invalid format`; 404 `export not found`; 503 `exports are not available` (no bucket configured); 500 `unable to create the
export` and `unable to retrieve the export`.
