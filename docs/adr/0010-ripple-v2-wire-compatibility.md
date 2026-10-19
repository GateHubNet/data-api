# ADR-0010: Ripple Data API v2 wire compatibility, and every deliberate deviation

**Status:** Accepted (amended by [ADR-0013](0013-account-and-market-aggregates.md): section 2, items 10a to 10f, the routes and parameters of the account and market aggregates).

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

**Added by the account and market aggregates ([ADR-0013](0013-account-and-market-aggregates.md)); the wording is in [api-reference](../api-reference.md#account-analytics-get-v2accountsaddressanalytics):**
10a. **New routes (extras, not in the original):** `/v2/accounts/{address}/analytics/{balances, balance_changes, counterparties, exchanges}` and `/v2/network/markets`. Their object shapes
    and key orders are ours, pinned by tests, and none serves an AMM field.
10b. **New parameters on routes of the original:** `interval` (`day`, `week`, `month`) on `/v2/accounts/{address}/stats/{family}` and on `/v2/accounts/{address}/reports`. Without it the answers are the
    original's. Before this change an `interval` there was ignored like any unknown parameter, so **a client that sent one now gets buckets**. With `interval`, `stats/value` has a row for every bucket from the first one in which
    the account had a balance up to the bucket that holds now, not only for active ones; `reports` allows 200 buckets of the interval (200 days, weeks or months; 200 months is all of the history), `payments=true` stays per day (400 `payments can only be listed with interval day`
    with a week or a month), and the counterparties of a bucket are counted over the whole bucket.
10c. **Markets:** `network/markets` lists every pair that traded, not a configured list; its windows start on the hour (those of the live volumes are exact); the native volume of a pair goes through the window's rate of any native pair
    (`exchange_volume` takes only the configured native markets); prices are in the canonical stored orientation. `network/exchange_volume` is unchanged, so for a configured market the two routes can differ.
10d. **Analytics windows are whole UTC days, `end` included** (as `reports`), unlike the exclusive `end` of `stats/{family}`; with an `interval` they widen to whole buckets, at most 1000.
10e. **Valuing balance changes:** a change on a line the account owes on (its balance is below 0) is valued as the account's own IOU; LP tokens and assets without a DEX rate are worth 0, as in `stats/value` and `reports`.
10f. **Unclassified balance changes** (those of transaction types the original never classified) are a group without a `change_type` key in `analytics/balance_changes`, as the `balance_changes` objects leave it out.

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

## Consequences
**Positive**
- A client of `data.ripple.com` works with a new host and an API key; the differences are enumerated, justified and tested.
- Bug fixes are visible, not silent: they are listed here and pinned by tests.

**Negative / trade-offs**
- Reproducing served behaviour reproduces oddities (string-typed ledger fields, copied failure messages such as `unable to retrieve payments` on the reports route).
- Markers, exact amounts and canonical transactions differ from the original in digits or tokens a client should not parse.
- The deviation list must be maintained: a new ruling that changes served behaviour adds a line here and to [api-reference](../api-reference.md).
