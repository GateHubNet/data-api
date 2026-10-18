# API reference

The GateHub Data API is a drop-in replacement for the **Ripple Data API v2**
([rippled-historical-database](https://github.com/ripple/rippled-historical-database), served as
`data.ripple.com`) for the **XRP Ledger** and for **Xahau**. Every endpoint of the Ripple API keeps its path, its parameters, its
defaults and limits, its error messages and the shape and key order of its answers, so a client written for `data.ripple.com`
works against it with two changes: it sends an API key, and it points at the host of the network it wants (see
[Compatibility](#compatibility)).

This page is the contract. The machine-readable parameter listing is [openapi.yaml](openapi.yaml) (also served live by the
API at `/internal/docs`, `/internal/docs-json`). The reasons behind every deliberate difference from `data.ripple.com` are in
[ADR-0010](adr/0010-ripple-v2-wire-compatibility.md).

Contents: [Conventions](#conventions) · [Ledgers](#ledgers) · [Transactions](#transactions) · [Payments](#payments) ·
[Exchanges](#exchanges) · [Rates and normalize](#exchange-rates-and-normalize) · [Accounts](#accounts) ·
[Active accounts](#active-accounts) · [Network](#network) · [AMM](#amm) · [Validations](#validations) · [Stats](#stats) ·
[Operational endpoints](#operational-endpoints)

---

## Conventions

### Hosts: one per network

One deployment serves one network. The two deployments run the same images and answer the same paths:

| Network | Host (behind the shipped nginx) | Native currency | Notes |
| --- | --- | --- | --- |
| XRP Ledger | `xrpl.data.<domain>` | `XRP` | CTID network id 0 |
| Xahau | `xahau.data.<domain>` | `XAH` | CTID network id 21337 |

The paths are `/v2/...` on both hosts. The **native currency** of the network is the one that has no issuer: `XRP` on the XRP
Ledger, `XAH` on Xahau. Wherever this page says "the native currency" it means that one; `XRP+rIssuer` on Xahau is an issued
currency called `XRP`, and `XAH` on the XRP Ledger is an issued currency called `XAH`. Amounts of the native currency are
always in whole units (drops divided by 1,000,000), as exact decimal text.

### Authentication

Every `/v2/*` request needs an API key, in a header:

```
X-API-Key: <key>
Authorization: Bearer <key>      (alternative)
```

Keys are configured with `GH_API_KEYS` (comma separated). A missing or unknown key answers **401**:

```json
{ "result": "error", "message": "Missing or invalid API key." }
```

This is the one deliberate break with `data.ripple.com`, which had no keys. The key is checked before the rate limit, so a
request with a bad key uses nobody's budget. Open (keyless) paths are `/liveliness/*` (probe), the metrics port and the
Swagger docs; see [Operational endpoints](#operational-endpoints). With `GH_API_KEYS` empty the check is off, which only the
development setups allow: a production boot with no key (or with the placeholder keys `dev-api-key` / `change-me...`) is
refused.

### Rate limit

Each client address gets `GH_RATE_LIMIT` requests (default **600**) per `GH_RATE_LIMIT_WINDOW` seconds (default **60**) on each
route. The client address is the one behind the reverse proxy (`X-Forwarded-For`, see [security](security.md)). Past the
limit the answer is **429** with the wording of the original, and these headers:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 4
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 4

{ "error": "Rate limit exceeded, retry in 3.27sec" }
```

`Retry-After` and `X-RateLimit-Reset` are whole seconds until the window ends (a delta, not a clock time); the body has the
time left with two decimals. Requests that pass carry `X-RateLimit-Limit`, `-Remaining` and `-Reset` as well.

### Errors

Every error of a `/v2` route is JSON in the shape of the original. That includes a malformed percent-escape in a path parameter, such as
`/v2/accounts/%zz/payments`, which Express fails to decode before any route runs: `400 {"result":"error","message":"Failed to decode param
'%zz'"}` (the text Express gives the error, naming the segment; see [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md#5-closed-in-the-final-review-were-known-gaps)):

```json
{ "result": "error", "message": "invalid start date format" }
```

| Status | When |
| --- | --- |
| 400 | A parameter is invalid. `message` is the exact text of the original route (listed per endpoint below). |
| 401 | No or unknown API key (`Missing or invalid API key.`). |
| 404 | The thing asked for does not exist (`ledger not found`, `transaction not found`, `Account not found`, `validation not found`), or the route does not exist: `{"result":"error","message":"Cannot GET /v2/nope"}`. |
| 429 | Rate limit, body `{"error":"Rate limit exceeded, retry in N.NNsec"}`. |
| 500 | Anything else. The body carries the failure message of the route (`unable to retrieve ledger`, `unable to retrieve payments`, ...), never a stack trace or a database message; the cause is in the service log. A route without a message of its own says `internal error`. |

Errors are never cacheable (`Cache-Control: no-store`). Unknown query parameters are ignored, as in the original. When a
parameter is repeated (`?limit=5&limit=10`) the first value wins.

### Parameters

| Kind | Rule |
| --- | --- |
| Booleans (`descending`, `binary`, `expand`, `transactions`, `reduce`, `autobridged`, `live`, `accounts`, `payments`) | True when the text matches `/true/i` (`TRUE`, `True`, even `xtruex`); `1` is not true. |
| `strict` | False only when the text matches `/false/i`; anything else, or nothing, is true. |
| `include_exchanges` | True for any non-empty text, `0` and `false` included. |
| `limit` | The default and the maximum differ per endpoint (listed below). Missing or empty gives the default; more than the maximum gives the maximum; a decimal is cut to its whole part; below 1 gives the default. Text that is not a number gives the default, except on the routes that answer `invalid limit` (`/v2/accounts/{address}/balances`, `/orders`) or `invalid limit: NaN` (the exchanges routes). |
| `amm` (the exchange lists) | `include` (default, also when missing or empty), `exclude` or `only`; case-sensitive. Anything else answers 400 `invalid amm filter - use: include, exclude, only`. See [Exchanges](#exchanges). |
| `marker` | An opaque token from the previous page (see [Pagination](#pagination)). A marker that is not one answers 400 `invalid marker`. |
| `format` | `json` (default) or `csv`, in any letter case. See [CSV](#csv). |

**Dates** (`start`, `end`, `date`, `period` starts) are read in UTC in these formats (a whole-text match; `YYYY` is a year
and so on):

```
YYYY   YYYY-MM   YYYY-MM-DD   YYYY-MM-DDTHH   YYYY-MM-DDTHH:mm   YYYY-MM-DDTHH:mm:ss
YYYY-MM-DDTHH:mm:ssZ   YYYY-MM-DDTHH:mm:ss.SSSZ   (a zone is Z or +hh, +hhmm, +hh:mm)
YYYYMMDDHHmmss   YYYYMMDDHHmmssSSS   1234567890 (ten digits: unix seconds)
```

`start` is inclusive, to the second: a `start` with milliseconds is the second it falls in (`start=…T18:27:10.750Z` takes the
ledgers that closed at 18:27:10), as the original's row keys were. `end` is inclusive at the precision it is written with:
`end=2015-08-31` is the whole of that day, `end=2015-08-31T10` the whole hour. (`stats/{family}` of an account is the exception, its `end` is an instant and exclusive.) A
text that is not a date answers 400 with the message of the parameter (`invalid start date format`, `invalid end date format`,
`invalid date format`). Lists are ordered by **ledger**, which is how the time axis works here: `start` and `end` select the
ledgers that closed in the window, and within a ledger the order is the order of the transactions in it.

### Output formats

| What | Format |
| --- | --- |
| Times (default) | `YYYY-MM-DDTHH:mm:ssZ`, UTC (`executed_time`, `inception`, `date`, `close_time` of `last_validated`) |
| `date` of a transaction | `YYYY-MM-DDTHH:mm:ss+00:00` |
| `close_time_human` of a ledger | `YYYY-MMM-DD HH:mm:ss` (`2015-Jan-14 17:29:10`) |
| Datetimes of a validation | `YYYY-MM-DDTHH:mm:ss.SSSZ` |
| Amounts | Exact decimal **strings** in whole units of the currency (`"0.000012"`, `"1500"`). `rate`, `vwap`, `open`, `high`, `low`, `close` are strings with 8 significant digits (`"0.0040000000"`). |
| Stats and fees | JSON numbers (`avg`, `max`, `total`, `transaction_count`, ...) |

Success bodies leave out a field that has no value (no `destination_tag` key for a payment without one, no issuer key for the
native currency); `null` is never used for "nothing". Keys come in the order of the original, which is the order its
database returned columns in (documented per endpoint), and the key order is the same in CSV columns.

### Pagination

List endpoints take `limit` and `marker` and answer `{ "result": "success", "count": <rows in this page>, "marker": "...", <rows> }`.
When there are more rows the answer carries a `marker`, and the same URL with `marker=<it>` is the next page. The `Link`
header carries that URL ready to follow (also on CSV pages), and the last page has neither:

```
Link: <https://xrpl.data.example.com/v2/payments?limit=200&marker=WzEwNzY3MDM2MCw1XQ>; rel="next"
```

A marker is the base64url of the key of the last row of the page, so it is stable under new data and a page costs the same
at any depth. Markers of this API are not interchangeable with those of `data.ripple.com` (which were HBase row keys), and a
marker works only for the endpoint and sort direction it came from. Walking the pages and concatenating them gives exactly
the unpaged list.

### CSV

Routes that list rows answer `format=csv` with `Content-Type: text/csv` and `Content-Disposition: attachment;
filename="<name>.csv"; filename*=UTF-8''<name>.csv` (RFC 6266: the name quoted, `"` and `\` escaped and anything but printable
ASCII as `_`, and the name itself in UTF-8, percent-encoded; clients show the latter). Nested objects are flattened to `a.b` and `c[0].d` columns, the columns are the union of the keys in the
order of first appearance, and every cell is quoted. Routes with a CSV form say so below, with the file name.

**Differences from data.ripple.com**: flattening is applied on **every** route that has a CSV form. The original flattened nested objects with
its `flattenJSON` helper on only some routes (9 of 29) and printed `[Object]` in the cells of the others, which made those CSVs unusable. The
other conventions of its CSV writer (`nice-json2csv`: union-of-keys header, every cell quoted, `\"` escaping) are kept. The original wrote the file
name unquoted (`filename=payments - USD r….csv`), so a name with a `;`, a quote or a space from the request split the header; the
name is the same, quoted (M12).

### Caching and transport

Successful `/v2` answers carry `Cache-Control: private, max-age=60` (the `GH_CACHE_CONTROL` setting; empty sends no header):
`private`, because an answer is for the holder of an API key and a shared cache that ignores the key would serve it to anybody. The
live routes `/balances` and `/orders` send their own (see there).
Responses are gzip-compressed when the client asks for it. CORS headers are sent only for the origins in `GH_CORS_ORIGINS`.
Run the API behind TLS: it speaks plain HTTP and trusts the proxy in front of it (see [deployment](deployment.md)).

### Compatibility

| | `data.ripple.com` | This API |
| --- | --- | --- |
| Host | one | one per network, see above |
| API key | none | required on `/v2/*` |
| Paths, parameters, defaults, limits | | the same |
| Error shape and messages | `{result:"error", message}` | the same |
| Markers | HBase row keys | opaque tokens, same mechanism (`marker` + `Link`) |
| Bugs of the original | | fixed where they were outright bugs; listed per endpoint and in [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md) |

Endpoints that exist here and not in the original: `GET /v2/exchanges` (the exchanges of all pairs) and the [AMM](#amm) endpoints (`/v2/amm/pools...`,
`/v2/accounts/{address}/amm_liquidity`, `/v2/accounts/{address}/amm_positions`, `/v2/network/amm_volume`). Exchange-based endpoints also differ in
what they count: **swaps against AMM pools are exchanges here** (the original predates AMMs), see [Exchanges](#exchanges) and
[ADR-0010](adr/0010-ripple-v2-wire-compatibility.md#6-amm-swaps-are-exchanges-adr-0011).

**Out of scope.** The original served more than the endpoint set this API was asked to implement. These routes of the original
(`api/server.js` of the `master` branch) are **not part of this API and answer 404** `{"result":"error","message":"Cannot GET ..."}`:

| Group | Routes of the original |
| --- | --- |
| Health, gateways, currencies | `/v2/health[/{aspect}]`, `/v2/gateways[/{gateway}]`, `/v2/gateways/{gateway}/assets[/{filename}]`, `/v2/currencies[/{currencyAsset}]` |
| Network | `/v2/network/external_markets`, `/v2/network/xrp_distribution`, `/v2/network/top_markets[/{date}]`, `/v2/network/top\_currencies[/{date}]`, `/v2/network/topology`, `/v2/network/topology/nodes[/{pubkey}]`, `/v2/network/topology/links`, `/v2/network/validators[/{pubkey}]`, `/v2/network/validators/{pubkey}/manifests`, `/v2/network/validators/{pubkey}/reports`, `/v2/network/validator_reports`, `/v2/network/rippled_versions` |
| Accounts | `/v2/accounts/{address}/escrows`, `/v2/accounts/{address}/payment_channels` |
| Reports and tools | `/v2/reports[/{date}]`, `/v2/maintenance/{domain}`, `/v2/estimate` |
| API map | `GET /` and `GET /v2` (the index of all routes) |

The original's 404 body also carried an `api-map` key (the same index); here it is `{"result":"error","message":"Cannot GET <url>"}`
only. That Ripple-shaped 404 covers every path under `/v2`. A path outside `/v2`, `GET /` included, is not part of the Ripple
contract: it answers the platform's own 404, `{"error":{"key":"NOTFOUNDEXCEPTION","message":"Cannot GET /"}}`. The old GateHub `/v2/ledgers` time-range list is gone too: `/v2/ledgers` without an identifier is the latest ledger, as in Ripple.

The singular `/v2/ledger/{hash}/validations[/{pubkey}]` is served as an alias of `/v2/ledgers/{hash}/validations[/{pubkey}]`. It appeared
only in the original's **README**, not in the route table of either branch's `server.js`; it is provided because that README documented it
and it was asked for. Anything else under `/v2` is a 404.

Each endpoint below ends with **Differences from data.ripple.com** where this API serves something else than the original did.

---

## Ledgers

### `GET /v2/ledgers[/{ledger_param}]`

A validated ledger. A ledger is served only once everything the syncer derives from it has been written (the `ledgers` row is
the commit marker), so a ledger that is half ingested is not visible.

| Parameter | Where | Default | Meaning |
| --- | --- | --- | --- |
| `ledger_param` | path, optional | latest ledger | Tested in this order: **digits** are a ledger index (`2015` is ledger 2015, never a year); a **date** is the last ledger that closed within the period the text names (`2015-01-14` is the last ledger of that day, `2015-01-14T17:43` the last up to 17:43:59, a full time that second); an **even-length hex** string is a ledger hash (any letter case). |
| `ledger_index`, `ledger_hash`, `date` | query | | The same selectors when there is no path identifier. The path identifier replaces the query parameter of its own kind; what is left is weighed `ledger_hash` > `date` > `ledger_index`. |
| `transactions` | query | false | Add `transactions`: the hashes of the transactions of the ledger, in ledger order. |
| `expand` | query | false | Add `transactions` as full transaction objects (no `ledger_hash` in them). |
| `binary` | query | false | Add `transactions` as transaction objects whose `tx` and `meta` are hex. **`binary` wins over `expand`, both win over `transactions`.** |

Answer (a ledger with `transactions=true`; the key order is the order of the original, the last five keys are the raw-ledger
leftovers that the original served and clients may read):

```json
{
  "result": "success",
  "ledger": {
    "ledger_hash": "A1B2…",
    "ledger_index": 11119015,
    "parent_hash": "C3D4…",
    "total_coins": "99994758814182467",
    "close_time": 1421256190,
    "close_time_human": "2015-Jan-14 17:43:10",
    "close_time_resolution": "10",
    "close_flags": "0",
    "parent_close_time": 1421256180,
    "account_hash": "E5F6…",
    "transaction_hash": "0718…",
    "hash": "A1B2…",
    "seqNum": "11119015",
    "totalCoins": "99994758814182467",
    "accepted": "true",
    "closed": "true",
    "transactions": ["…", "…"]
  }
}
```

Types are those the original served from its HBase row: numbers for `ledger_index`, `close_time` and `parent_close_time` (unix
seconds, omitted when the ledger has none); **strings** for everything else, including `total_coins` (drops, exact),
`close_time_resolution` (`"10"`) and `close_flags` (`"0"`). `accepted` and `closed` are the text `"true"`.

Errors: 400 `invalid ledger identifier` (the path text is none of the three), 400 `invalid date format` (`date` query);
404 `ledger not found` (also for a `ledger_index` query that is not a whole number); 500 `unable to retrieve ledger`
(including a ledger whose stored transactions are fewer than its `tx_count`). No CSV.

**Differences from data.ripple.com**
- `ledger_hash` in the query is upper-cased (the original compared the raw text with an upper-case key, so lower case never
  matched). A hash with a `0x` prefix passes the hex test as before and finds no ledger.
- A date that carries milliseconds includes its own second ("closed at or before").
- `expand` and `binary` on a ledger without transactions and without `transactions=true` have no `transactions` key (as
  before); with `transactions=true` it is `[]`.
- `close_flags` is served as `"0"` for ledgers whose source had none (the original omitted the column).
- The transactions of `expand`/`binary` are served in the canonical form of [transactions](#transactions) below.

### `GET /v2/last_validated`

An extra of the original that its README never listed: the newest ledger this deployment has committed.

```json
{ "result": "success", "ledger_index": "107695660", "ledger_hash": "…", "parent_hash": "…", "close_time": "2026-10-16T12:00:00Z" }
```

`ledger_index` is a string, as the original served its control row. On an empty database the answer is 500 `unavailable`
(the original never answered at all).

---

## Transactions

### `GET /v2/transactions/{tx_hash}`

| Parameter | Default | Meaning |
| --- | --- | --- |
| `tx_hash` (path) | | Transaction hash, any letter case, an even number of hex digits. |
| `binary` | false | `tx` and `meta` as upper-case hex of the serialized transaction and metadata. |

```json
{
  "result": "success",
  "transaction": {
    "hash": "…", "ledger_index": 11119603, "date": "2015-01-14T18:27:20+00:00",
    "tx":   { "TransactionType": "Payment", "Account": "r…", "…": "…" },
    "meta": { "TransactionIndex": 12, "TransactionResult": "tesSUCCESS", "AffectedNodes": [], "delivered_amount": "…" }
  }
}
```

The object is `{hash, ledger_index, date, tx, meta}` in that order. `meta.delivered_amount` is added to every successful
`Payment`: the metadata's `DeliveredAmount`, else the transaction's `Amount`, except for a *partial* payment from before the
ledger the XRP Ledger fixed this in (4,594,094), which has `"unavailable"`. Xahau has no such cut-off.

Errors: 400 `invalid hash`; 404 `transaction not found`; 500 `unable to retrieve transaction(s)`. No CSV.

### `GET /v2/transactions`

The transactions of the ledgers that closed in a window, oldest first, each with the hash of its ledger.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start` | `2013-01-01` | Start of the window. |
| `end` | the newest ledger | End of the window (inclusive at its precision). |
| `type` | all | A transaction type of the network (`Payment`, `OfferCreate`, `NFTokenMint`, `URITokenMint` on Xahau, ...). |
| `result` | all | A transaction result code of the network (`tesSUCCESS`, `tecPATH_PARTIAL`, ...). |
| `binary` | false | `tx` and `meta` as hex. |
| `descending` | false | Newest first. |
| `limit` | 20 (max 100) | |
| `marker` | | Next page. |

`{ "result": "success", "count": 20, "marker": "…", "transactions": [ {hash, ledger_index, date, ledger_hash, tx, meta}, … ] }`.

Errors: 400 `invalid start date format`, `invalid end date format`, `invalid transaction type`, `invalid transaction result`,
`invalid marker`; 500 `unable to retrieve transaction(s)`. No CSV.

**Differences from data.ripple.com**
- `type` and `result` are validated against the **definitions of the network** (fetched from the node, with a bundled fallback)
  instead of the stale lists of 8 types and 32 results that the original kept in its route file. Newer types and codes are
  accepted (`NFTokenMint`, `AMMCreate`, `tecKILLED`); Xahau types are accepted on Xahau and rejected on the XRP Ledger.
- `tx` and `meta` are served in the **canonical form**: the stored JSON is encoded to the binary format and decoded again with
  the network's definitions, as the original (which stored binary) did. So `DeliverMax` and the `type`/`type_hex` of `Paths`
  steps are not in the JSON, UInt64 fields are 16 upper-case hex digits, and the fields come in binary-format order. The
  `binary=true` hex is the serialization itself and re-hashes to the transaction hash (the transactions of a ledger re-hash to
  its `transaction_hash`). An AccountID that the node shows as `""` (the `Account` of Xahau's `UNLReport`) is `""` in the JSON
  and a zero-length field (`81 00`) in the binary form, as the node serializes it. A transaction that the codec cannot serialize (a type missing from the definitions) is served as its
  stored JSON instead of failing the page, and `api_tx_encode_fallback_total` counts it.
- A hash with a `0x` prefix is `invalid hash` (as in the original, where the check could never match it).
- A missing `end` is open-ended (the newest ledger); the original used the time of the request.
- Markers are not HBase row keys, see [Pagination](#pagination). Order within one ledger is the transaction order.

---

## Payments

### `GET /v2/payments[/{currency}]`

Successful `Payment` transactions between two different accounts (a payment to oneself is a conversion, not a payment),
oldest first.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `currency` (path) | all | `CUR+issuer` (the separators `+`, `\|` and `.` all work, the currency is upper-cased) or the native currency alone. The currency is that of the payment's `Amount`. |
| `start` | the beginning | |
| `end` | the newest ledger | |
| `descending` | false | |
| `limit` | 200 (max 1000) | |
| `marker` | | |
| `format` | json | `csv`: file `payments[ - CUR][ issuer].csv`. |

```json
{
  "result": "success",
  "count": 1,
  "marker": "…",
  "payments": [
    {
      "amount": "100", "delivered_amount": "100",
      "destination_balance_changes": [{ "counterparty": "", "currency": "XRP", "value": "100" }],
      "source_balance_changes": [{ "counterparty": "", "currency": "XRP", "value": "-100" }],
      "tx_index": 5, "currency": "XRP", "destination": "r…", "destination_tag": 1234,
      "executed_time": "2015-01-14T18:27:20Z", "ledger_index": 11119603,
      "source": "r…", "source_currency": "XRP", "tx_hash": "…", "transaction_cost": "0.000012"
    }
  ]
}
```

Key order is the order of the original's row: `amount, delivered_amount, destination_balance_changes, max_amount?,
source_balance_changes, tx_index, currency, destination, destination_tag?, executed_time, invoice_id?, issuer?, ledger_index,
source, source_currency, source_tag?, tx_hash, transaction_cost`. `issuer` is absent for the native currency, tags that
the payment does not have are absent (a tag of `0` is a tag and is served). `transaction_cost` is the fee in whole units.
The balance changes carry an empty `counterparty` for the native currency; the native balance change of the source does not include the fee (that is `transaction_cost`).

Errors, in the order they are checked: 400 `invalid issuer address`, `invalid start date format`, `invalid end date format`,
then for the path `currency is required`, `XRP cannot have an issuer` (`XAH` on Xahau), `issuer is required`;
`invalid marker`; 500 `unable to retrieve payments`.

**Differences from data.ripple.com**
- `/v2/payments/XRP+rIssuer` is 400 (the original accepted it and searched an empty key range), and `/v2/payments/+rIssuer`
  is 400 `currency is required` (the original returned all payments).
- Tags of `0` are kept (the original dropped a falsy tag, losing a real routing tag).
- The response has no top-level `currency`/`issuer` (the original's route read them from a result that never had them).
- The CSV file name is built from the request (`payments - USD rIssuer.csv`); the original's formula repeated the currency and
  in practice produced `payments  .csv`.
- Payments with MPT amounts are not payments of this API.
- A missing `end` is open-ended (the original used the time of the request).

---

## Exchanges

### `GET /v2/exchanges/{base}/{counter}`

The trades (offer crossings and AMM swaps) between two assets, oldest first. `base` and `counter` are `CUR+issuer` (separator
`+`, `|` or `.`) or the native currency alone. A pair asked for in the reverse of the stored order is **inverted**: base and
counter swap with their currencies, issuers and amounts, buyer and seller swap, and the `rate` is `1/rate`.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start` | `2013-01-01` | |
| `end` | the newest ledger | |
| `interval` | none | Candles instead of trades: `1minute`, `5minute`, `15minute`, `30minute`, `1hour`, `2hour`, `4hour`, `1day`, `3day`, `7day`, `1month`, `1year` (`week` means `7day`; the text is lower-cased). |
| `reduce` | false | One row summarizing the whole window. Not together with `interval`. |
| `autobridged` | false | Only the autobridged trades (the crossing went through the native currency). |
| `amm` | `include` | Swaps against AMM pools are exchanges too. `include` lists them with the order-book trades, `exclude` lists the order-book trades only (what this route served before AMM), `only` lists the swaps only. Applies to the raw trades, to `interval` and to `reduce`. Anything else is 400 `invalid amm filter - use: include, exclude, only`. |
| `descending` | false | Newest first. |
| `limit` | 200 (max 400) | A text that is not a number is 400 `invalid limit: NaN`. |
| `marker` | | |
| `format` | json | `csv`: file `exchanges - BASE-COUNTER.csv`. |

**Raw trades** (`exchanges`), keys in the order of the original's row:

```json
{
  "result": "success",
  "count": 1,
  "marker": "…",
  "exchanges": [{
    "base_amount": "50", "counter_amount": "0.4545454545", "node_index": 4, "rate": "0.0090909091", "tx_index": 12,
    "buyer": "r…", "executed_time": "2015-01-14T18:27:20Z", "ledger_index": 11119603, "offer_sequence": 1517,
    "provider": "r…", "seller": "r…", "taker": "r…", "tx_hash": "…", "tx_type": "OfferCreate",
    "base_currency": "USD", "base_issuer": "r…", "counter_currency": "XRP"
  }]
}
```

Order: `base_amount, counter_amount, node_index, rate, tx_index, autobridged_currency?, autobridged_issuer?, buyer, executed_time,
ledger_index, offer_sequence, provider, seller, taker, tx_hash, tx_type, base_currency, base_issuer?, counter_currency,
counter_issuer?, amm_account?`. `rate` is counter per base, 8 significant digits. The native currency has no issuer key; the autobridged
fields are present only on an autobridged trade. Trades whose native-currency leg is **0.0005 or less** are left out of the
aggregates (candles, `reduce`), swaps included.

**Swaps against an AMM pool** ([ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md)) are exchanges: a `Payment` or `OfferCreate` that
crosses a pool moves the pool's balances, and each pool crossed is one row. Its `amm_account` is the pool (the **last key**, present only on
a swap, so an order-book trade is served exactly as before AMM), and it is also the `provider`; `offer_sequence` is `0`. `taker` is the
account that sent the transaction. If base flowed out of the pool, `buyer` is the taker and `seller` is the pool, otherwise the reverse.
`node_index` is the index of the pool's account node in the transaction metadata (or of its first reserve trust line when the metadata has
no account node), which keeps the key unique. A transaction that crosses several pools, or a pool and an order book, gives a row for each.
`tx_type` is the type of the transaction, and `autobridged_*` follow the rules of the order book. **The amounts are the pool's own
changes** (`base_amount` and `counter_amount` are what the pool received and paid, unsigned), which on the asset the pool pays out include
the issuer's transfer fee: for an issuer with a `TransferRate` of 1.002 the pool pays 83.28354 and the receiver gets 83.11731. An
order-book trade uses the change of the offer's `TakerGets`, which leaves the fee out, so the `rate` of a swap through a pool with such an
issuer is biased by up to the fee. To get the swaps of a pool, use [`GET /v2/amm/pools/{pool}/swaps`](#get-v2ammpoolspoolswaps).

**Candles** (`interval=...`): the candles of the buckets that start within the window. A bucket is whole (a `start` inside a
bucket leaves that bucket out, an `end` inside one takes all of it). Buckets are aligned in UTC: minutes and hours on the
clock, `Nday` counted from 2013-01-01, `7day` from Monday, months and years on the calendar.

```json
{ "base_volume": "1500", "buy_volume": 600, "close": "0.0090909091", "close_time": "2015-01-14T18:59:50Z", "count": 12,
  "counter_volume": "13.63636364", "high": "0.0100000000", "low": "0.0085000000", "open": "0.0088000000",
  "open_time": "2015-01-14T18:00:10Z", "start": "2015-01-14T18:00:00Z", "vwap": "0.0090909091",
  "base_currency": "USD", "base_issuer": "r…", "counter_currency": "XRP" }
```

Order: `base_volume, buy_volume, close, close_time, count, counter_volume, high, low, open, open_time, start, vwap`, then the pair
as asked for. Prices are strings with 8 significant digits, volumes are exact decimal strings, `count` and `buy_volume` are
numbers. The marker of a candle page is the start of the bucket of its last candle.

**Reduced row** (`reduce=true`): `{ "result": "success", "count": 1, "exchanges": [ {open, high, low, close, base_volume,
counter_volume, buy_volume, count, open_time?, close_time?, vwap, start, base_currency, base_issuer?, counter_currency,
counter_issuer?} ] }`. It covers the whole window: `limit` and `marker` are ignored and there is no marker. `start` is the start
of the window. With no trade the row is all zeros (`"0.0000000"` prices, `"0"` volumes) and has no `open_time`/`close_time`.

CSV: the raw rows use the 20 columns of the original, in this order: `base_currency, base_issuer, base_amount, counter_amount,
counter_currency, counter_issuer, rate, executed_time, ledger_index, buyer, seller, taker, provider, autobridged_currency,
autobridged_issuer, offer_sequence, tx_type, tx_index, node_index, tx_hash`, and an `amm_account` column last when the page holds a
swap (empty in the order-book rows), so a CSV of order-book trades has the columns it had before AMM. Candle and reduce rows use a fixed list of 16 columns, in this
order: `open, high, low, close, vwap, count, base_currency, base_issuer, base_volume, counter_currency, counter_issuer, counter_volume,
open_time, close_time, start, buy_volume` (an empty cell where a row has no value, e.g. `open_time` of an empty reduce row).

Errors, in the order they are checked: 400 `base currency is required`, `counter currency is required`, `XRP cannot have an
issuer` (`XAH` on Xahau), `base issuer is required`, `counter issuer is required`, `invalid base issuer address`,
`invalid counter issuer address`, `invalid start date format`, `invalid end date format`, `invalid limit: NaN`,
`invalid amm filter - use: include, exclude, only`, `cannot use reduce with interval`, `invalid interval: <text>`, `invalid marker`; 500
`unable to retrieve exchanges`.

**Differences from data.ripple.com**
- Amounts are the **exact** stored decimal text; the original round-tripped them through floats, which only changes digits
  beyond the 15th significant one. The inverse rate is computed with 200 decimal places (the default 20 turns the inverse of a
  rate above 10^12 into 0), then rounded to 8 significant digits.
- Candle and reduce volumes are **exact sums** (the original summed floats and served texts like `50.00000000000001`), and the
  same request always gives the same digits.
- An invalid `interval` is 400 whatever the `limit` (the original skipped the check when `limit` was over 400 and then failed
  with 500).
- Inverted candles compute `buy_volume` from the inverted trades (the original approximated it with the vwap).
- `autobridged=true` works with `interval` (the original's candles filtered on a column that did not exist and were empty).
- `reduce` covers the whole window and starts at the window's start (the original reduced only the first page and wrote the
  time of the request as `start`); the native-leg filter is `<= 0.0005` in both paths (the original used `<` in one).
- The CSV of candles and reduce rows has `buy_volume` in every row (the original lost it in the first row).
- Pair routes validate issuer addresses (`invalid base issuer address`); the original answered an empty 200.
- Trades whose rate cannot be derived (a zero leg) or that involve MPT amounts are not stored, instead of being served as
  `NaN`/`Infinity`.
- A limit below 1 gives the default instead of reaching the database as given.
- **Swaps against AMM pools are included** (default `amm=include`), in the raw trades, the candles and `reduce`, with `amm_account` as a
  last key on the swaps; `amm=exclude` serves what the original would have. The original predates AMMs. See
  [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md#6-amm-swaps-are-exchanges-adr-0011).

### `GET /v2/exchanges`

An extra that `data.ripple.com` did not have: the trades of **all** pairs, each with the pair it is stored under (the canonical
Ripple order: the pair is sorted by the lower-cased `currency+issuer` text), oldest first. A page reads one window of ledgers from
the marker on, as long as the ledgers' own count of trades says the page needs, sorted to the page on its own, so a page costs the
trades near it, not the whole window, however long the gap before them (Ruling R107). Parameters: `start` (`2013-01-01`), `end`, `autobridged`, `amm` (as above), `descending`, `limit` (200, max 400), `marker`,
`format` (file `exchanges.csv`). Rows are the raw trades above. Errors, in order: 400 `invalid start date format`, `invalid end date format`, `invalid limit: NaN`,
`invalid amm filter - use: include, exclude, only`, `invalid marker`; 500 `unable to retrieve exchanges`. With `amm=only` a page reads the rest of the range in one read narrowed by a skip index on the pool column (Ruling R-A12): ask for a
window.

**Differences from data.ripple.com**: the route does not exist in the original (it is an extra, [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md)); everything said for
the raw trades above applies.

---

## Exchange rates and normalize

### `GET /v2/exchange_rates/{base}/{counter}`

How many `counter` one `base` buys.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `date` | now | The moment the rate is as of; it names a period (`2015-01-14` is a day, `2015-01-14T18` an hour) and the daily and latest windows read up to the end of it. Not in the future (10 ms of clock skew are tolerated). |
| `strict` | true | The latest-trades price counts only when there are at least 10 trades; `strict=false` counts however many there are. |
| `period` | none | `hour`, `day`, `3day`, `7day` or `30day`: the volume weighted price of the rolling window of that length that ends a second before `date`, instead of the default rate. |
| `live` | false | Leave out the daily part: only the latest trades. |

Swaps against AMM pools count as trades like any other (the latest-trades price and the volume weighted price of the day both include them).

The default rate combines two numbers: the volume weighted price of the day of `date` (from 00:00 UTC up to the **end of the period
`date` names**: the whole day for `date=2015-01-14`, up to the end of the hour for `date=2015-01-14T18`, up to that second for a full time,
never past the end of that day; without `date`, up to now; none with `live=true`) and the volume weighted price of the **last 50 trades** in the
14 days before `date` (up to the same end). The rate is their average when
both are above zero, otherwise the latest-trades price. With `strict` (the default) the latest-trades price counts only when
there are at least 10 trades in that window, otherwise it is 0, and so is the rate. Trades whose native leg is `<= 0.0005` do not
count. The same asset on both sides is `1`; a rate that cannot be told is `0` (`"0.0000000"`).

```json
{ "result": "success", "rate": "0.0090909091" }
```

Errors: the pair errors of the exchanges route, then 400 `invalid period: <text>`, `invalid date format`, `must not be a
future date`; 500 `unable to retrieve exchanges`. No CSV.

**Differences from data.ripple.com**
- An unparseable `date` (or an empty `date=`) is 400 `invalid date format`; the original failed with a 500.
- The same asset on both sides with a `period` is `1` (the original answered `0`).
- `period` is a direct rolling window ending at `date`; the original summed pre-aggregated buckets, so its edges were aligned
  to the bucket size. The daily part is the volume weighted price from 00:00 of the day of `date` to the end of the period `date`
  names, not the stored whole-day bucket (so a past `date` with a time of day reads to the end of that hour/minute/second, not the whole day).
- A `date` naming a month or year reads the first calendar day of that period for the daily part (the original read the first
  day that had trades).

### `GET /v2/normalize`

An amount of one currency in another, through the native currency:
`converted = amount × rate(currency → native) ÷ rate(exchange_currency → native)`, each rate being the one of
`/v2/exchange_rates`.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `amount` | required | A number. |
| `currency`, `issuer` | the native currency | The issuer is required for every currency but the native one. |
| `exchange_currency`, `exchange_issuer` | the native currency | The currency to convert to. |
| `date` | now | As above. |
| `strict` | true | As above. |

```json
{ "result": "success", "amount": "100", "converted": "909.0909090909", "rate": "9.0909091" }
```

`amount` is the number as JavaScript prints it, `converted` is the exact product printed as a JavaScript number, `rate` has 8
significant digits. The same currency and issuer on both sides is rate `1`; a currency without a rate gives `converted` `"0"`.

Errors: 400 `invalid amount` (not a number, or infinite), `XRP cannot have an issuer`, `issuer is required`, the issuer
address errors, `invalid date format`, `must not be a future date`; 500 `unable to retrieve exchanges`. No CSV.

**Differences from data.ripple.com**
- A failure is HTTP 500 with the route's body; the original answered the same body with status 200.
- A non-finite `amount` (`Infinity`, `1e999`) is 400 `invalid amount`; the original answered `Infinity`/`NaN` strings. Text that JavaScript reads as a number
  (`1e3`, ` 7 `, empty as `0`) is accepted as before.
- `converted` is the exact product of the amount and the rate printed as a JavaScript number (the original multiplied floats, so the last digit can differ).
- The rates behind it have the differences of `/v2/exchange_rates` above.

---

## Accounts

The `{address}` of the account routes is **not validated** (as in the original) except where a route says otherwise
(`/balances`, `/orders`): an address that does not exist simply has no rows. All account lists take the common window
parameters `start` (`2013-01-01` unless stated), `end`, `descending`, `limit` and `marker`.

### `GET /v2/accounts`

The accounts created in the ledgers of the window, oldest first.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end`, `descending`, `marker` | | |
| `parent` | all | Only the accounts that this address created (the sender of the creating transaction). |
| `limit` | 200 (max 1000) | |
| `format` | json | `csv`: file `accounts.csv`. |

```json
{ "result": "success", "count": 1, "marker": "…",
  "accounts": [{ "account": "r…", "parent": "r…", "initial_balance": "100", "inception": "2015-01-14T18:27:20Z",
                 "ledger_index": 11119603, "tx_hash": "…" }] }
```

`genesis_balance` and `genesis_index` appear on an account of the genesis ledger once a history import has loaded it; they
are absent today. Errors: 400 `invalid start date format`, `invalid end date format`, `invalid marker`; 500 `unable to get
accounts`.

### `GET /v2/accounts/{address}`

`{ "result": "success", "account_data": { account, parent, initial_balance, inception, ledger_index, tx_hash } }`. 404
`Account not found`; 500 `unable to get accounts`.

**Differences from data.ripple.com** (both routes): an address that was created more than once (deleted with `AccountDelete`
and funded again) answers with its **latest** creation; the original answered with the earliest. A transaction that creates
several accounts is listed once per account (the original kept the last).

### `GET /v2/accounts/{address}/transactions`

Every transaction that **affects** the account: sent, received, or touching one of its offers or trust lines. The rows are the
transaction objects of `/v2/transactions` without `ledger_hash`: `{hash, ledger_index, date, tx, meta}`.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start` | the first ledger (epoch) | |
| `end` | the newest ledger | |
| `min_sequence`, `max_sequence` | none | Switch to the **sequence mode**: the transactions the account **sent**, by their `Sequence`, both bounds inclusive. `start` and `end` are ignored. A reversed range (`min` greater than `max`) is swapped and serves the rows between. A non-numeric value is 400 `invalid min_sequence` / `invalid max_sequence`. |
| `type`, `result` | all | As on `/v2/transactions` (validated against the network). In sequence mode they filter on the sender's row. |
| `binary` | false | `tx` and `meta` as hex. |
| `descending` | false | |
| `limit` | 20 (max 1000) | |
| `marker` | | |

Errors: 400 `invalid start date format`, `invalid end date format`, `invalid min_sequence`, `invalid max_sequence`, `invalid
transaction type`, `invalid transaction result`, `invalid marker`; 500 `unable to retrieve transactions`. No CSV.

### `GET /v2/accounts/{address}/transactions/{sequence}`

The transaction the account sent with that `Sequence`, as `{ "result": "success", "transaction": {...} }` (`binary` is
supported). A transaction that used a ticket has Sequence 0: the latest of them is returned. 400 `invalid sequence number`;
404 `transaction not found`; 500 `unable to retrieve transaction`.

**Differences from data.ripple.com** (both routes): `max_sequence` is inclusive (the HBase scan dropped its row); `type` and
`result` are validated against the network definitions; a `min_sequence` above what a sequence can be gives an empty list and
a `max_sequence` above it is clamped, instead of a database error; `/{sequence}` above it is 404.

### `GET /v2/accounts/{address}/payments`

The payments (as `/v2/payments`) the account sent or received.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `type` | both | `sent` or `received` (lower-cased). A payment from the account to itself (the ingest stores none, a conversion is not a payment) would be listed once, and match both types, as in the original. |
| `currency`, `issuer` | all | Only payments of that currency (upper-cased) / issuer. |
| `source_tag`, `destination_tag` | all | Only payments with that tag; text that is not a tag matches nothing. |
| `start`, `end`, `descending`, `limit` (200, max 1000), `marker` | | |
| `format` | json | `csv`: file `<address> - payments[ <type>][ <CURRENCY>].csv`. |

`{ "result": "success", "count": …, "marker": …, "payments": [Payment, …] }`. Errors: 400 `invalid start date format`, `invalid
end date format`, `invalid type - use: sent, received`, `invalid marker`; 500 `unable to retrieve payments`.

**Differences**: `issuer` is applied (the original read it and never used it); a tag of `0` is a tag and can be filtered on.

### `GET /v2/accounts/{address}/exchanges[/{base}[/{counter}]]`

The trades the account took part in as buyer or seller. Each row is the exchange of `/v2/exchanges` plus the `client` when
there is one, with the pair among the other keys (not at the end): `base_amount, counter_amount, node_index, rate, tx_index,
autobridged_currency?, autobridged_issuer?, base_currency, base_issuer?, buyer, client?, counter_currency, counter_issuer?,
executed_time, ledger_index, offer_sequence, provider, seller, taker, tx_hash, tx_type, amm_account?`. A swap against an AMM pool
is an exchange of the taker and of the pool, and has `amm_account` (the pool) as its last key; `amm=include|exclude|only` keeps both
kinds (default), the order-book trades, or the swaps (see [Exchanges](#exchanges)). A pool account lists its own swaps here.

`base` and `counter` are **filters**, not a complete pair: `USD` is the dollars of every issuer, `USD+rIssuer` one issuer,
`/XRP` every trade against the native currency. They work in either orientation; a trade stored the other way round is
inverted (as in `/v2/exchanges`) so that the asset asked for as `base` is the base of what is served.

Parameters as the account lists (`limit` 200, max 1000) and `amm`; `format=csv`: file `<address> - exchanges[ - BASE[-COUNTER]].csv`, the 20
columns of `/v2/exchanges` plus, after them, a `client` column when a row of the page has a client and an `amm_account` column when a row of the page is a swap, in that order whichever row comes first (an empty cell in the rows without one).
Errors, in order: 400 `invalid base issuer address`,
`invalid counter issuer address`, `invalid start date format`, `invalid end date format`, `invalid amm filter - use: include, exclude, only`,
`invalid marker`; 500 `unable to
retrieve exchanges`.

**Differences**: the filter works for a pair asked for in the reverse order (the original compared with the stored order
literally and found nothing); issuers are validated; the CSV carries every row's 20 columns (the original rewrote only the
first row); the pair is the one asked for.

### `GET /v2/accounts/{address}/balance_changes`

Every change of a balance of the account (native currency and trust lines) made by the transactions of the window, oldest
first; the fee of a transaction comes first, as a `transaction_cost` row without a `node_index`.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `currency` | all | Upper-cased. |
| `counterparty` (alias `issuer`) | all | Not allowed together with the native currency. |
| `change_type` (alias `type`) | all | One of `transaction_cost`, `exchange`, `intermediary`, `payment_source`, `payment_destination`, `escrow_create`, `escrow_cancel`, `escrow_finish`, `paychannel_fund`, `paychannel_payout`. |
| `start`, `end`, `descending`, `limit` (200, max 1000), `marker` | | |
| `format` | json | `csv`: file `<address> - balance changes[ <CURRENCY>].csv`. |

```json
{ "result": "success", "count": 1, "marker": "…",
  "balance_changes": [{ "amount_change": "-100", "final_balance": "900", "node_index": 3, "tx_index": 5,
                        "change_type": "payment_source", "currency": "XRP", "executed_time": "2015-01-14T18:27:20Z",
                        "ledger_index": 11119603, "tx_hash": "…" }] }
```

Key order: `amount_change, escrow_balance_change?, final_balance, node_index?, paychannel_final_balance?,
paychannel_fund_change?, paychannel_fund_final_balance?, tx_index, change_type?, counterparty?, currency, escrow_counterparty?,
executed_time, ledger_index, paychannel_counterparty?, tx_hash`. The native currency has no `counterparty`; the fee row has no
`node_index`; `change_type` is absent on changes of transaction types the original never classified; the `escrow_*` and
`paychannel_*` fields appear only on the changes of a party to an escrow or payment channel. Amounts are exact decimal strings.

Errors: 400 `invalid start date format`, `invalid end date format`, `counterparty cannot be specified for XRP` (`XAH`),
`invalid change_type - use: transaction_cost, exchange, intermediary, payment_source, payment_destination, escrow_create,
escrow_cancel, escrow_finish, paychannel_fund, paychannel_payout`, `invalid marker`; 500 `unable to retrieve balance changes`.

**Differences**: the filter accepts the five escrow/payment-channel change types as well as the original's five (the rows carry
them and the original rejected them, so no client could filter on a type it was served); balance changes are produced for
every transaction type that moves a balance (RippleState changes of all transaction types, AMM pools included), where the
original's parser covered only some; no row is made for a fee of 0 (Batch inner transactions); `paychannel_balance_change` is
not served (the original computed it and never stored it).

### `GET /v2/accounts/{address}/balances`

The balances of the account on a ledger of the **live node** (`GH_NODE_ENDPOINTS`): `account_info` for the native balance,
`account_lines` for the trust lines.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `ledger_index` (alias `ledger`) | newest validated | A number, or `validated`, `closed`, `current`. Anything else is ignored. |
| `ledger_hash` | | 64 hex digits (400 `invalid ledger hash`). |
| `date` (alias `close_time`) | | The last ledger **stored by this API** that closed at or before it; the answer then carries its `close_time`. |
| `currency` | all | Only balances in that currency (compared as written). The native currency alone gives just the native balance. |
| `counterparty` (alias `issuer`) | all | Only the trust lines with that account (the native balance is not filtered). |
| `limit` | 200 (max 400) or `all` | Counts the native balance. `all` reads every trust line and has no `limit` in the answer. |
| `format` | json | `csv`: file `<address> - balances.csv`. |

Precedence: `ledger_hash` > `date` > `ledger_index`.

```json
{ "result": "success", "ledger_index": 107695660, "limit": 200,
  "balances": [{ "currency": "XRP", "value": "1000.5" }, { "currency": "USD", "counterparty": "r…", "value": "12.25" }] }
```

The native balance comes first and has no `counterparty`; trust lines follow in the node's order. Errors, in order: 400 `invalid
ripple address`, `invalid date format`, `invalid ledger hash`, `invalid limit`, 400 `the date provided is too old` (no stored
ledger that early, or the node no longer has the ledger), 404 `account not found`; 500 `unable to retrieve balances`.

Responses are cached in memory for `GH_LIVE_CACHE_TTL_MS` (default 10 s) per resolved request, so a `validated` answer is at
most that old; the body says which ledger it was read at. The answer says the same downstream: `Cache-Control: private,
max-age=<GH_LIVE_CACHE_TTL_MS in whole seconds>` (`private, max-age=10` by default), or `no-store` when the live cache is off
(`GH_LIVE_CACHE_TTL_MS=0`), in place of the global `GH_CACHE_CONTROL`. `limit=all` pages the node for at most 30 s in all; an
account that needs longer gets 500 `unable to retrieve balances`. The pages of trust lines after `account_info` are read from the
ledger named by `ledger_hash` or a numeric `ledger_index` as given, and from the index the node answered with for
`validated` / `closed` / `current` (a marker belongs to one ledger).

**Differences from data.ripple.com**: the default ledger is the newest **validated** one (the original asked for the open
ledger); `ledger_hash` is honored (it was ignored); trust lines are paged until the limit is filled with lines that pass the
filters (the original cut the first page and filtered afterwards, so a `currency` could miss lines); `limit=all` pages to
completion (within 30 s); a date older than the first stored ledger is 400 (the original answered 500); balances are exact decimal
strings.

### `GET /v2/accounts/{address}/orders`

The open offers of the account on a ledger of the live node, with the same ledger selectors, `limit` (200, max 400, or `all`),
error order, caching (the in-memory live cache and its `Cache-Control`), 30 s limit of `limit=all` and ledger of the pages after
the first as `/balances` (`currency` is ignored; `format=csv`: file `<address> - orders.csv`, flattened).

```json
{ "result": "success", "ledger_index": 107695660, "limit": 200,
  "orders": [{ "specification": { "direction": "sell",
                                   "quantity":   { "currency": "USD", "value": "10", "counterparty": "r…" },
                                   "totalPrice": { "currency": "XRP", "value": "50" } },
                "properties": { "maker": "r…", "flags": 131072, "sequence": 1517, "makerExchangeRate": "5" } }] }
```

A buy has the quantity it pays for and the total price it gets; a sell (the sell flag is set) the other way round.
`makerExchangeRate` is the offer's quality in whole units. 500 `unable to retrieve orders`; a malformed address is 400 `invalid
ripple address`.

**Differences**: `direction` is `sell` when the offer has the sell flag (the original hard-coded `buy`); the address is
validated (the original let the node fail with a 500); `limit=all` is honored; the default ledger is the validated one.

### `GET /v2/accounts/{address}/reports[/{date}]`

What the account sent and received, a report for each UTC day, with every value in the native currency.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `date` (path) | | One day: the report of the day of that date (replaces `start` and `end`). |
| `start` | now | The first day. |
| `end` | now | The last day (whole). |
| `accounts` (alias `counterparties`) | false | List the counterparties instead of counting them. |
| `payments` | false | List the payments of each day. |
| `descending` | false | Newest day first. |
| `format` | json | `csv`: file `<address> - reports.csv` (counterparty lists joined with `, `). |

The window may span at most 200 days (counted as the whole days between `start` and `end`).

```json
{ "result": "success", "start": "2015-01-14T00:00:00Z", "end": "2015-01-15T00:00:00Z", "count": 2,
  "reports": [{ "account": "r…", "date": "2015-01-14T00:00:00Z", "high_value_received": "0", "high_value_sent": "100",
                "total_value_received": "0", "total_value_sent": "100", "total_value": "100",
                "payments_sent": 1, "payments_received": 0, "receiving_counterparties": 1, "sending_counterparties": 0 }] }
```

A day without payments is a report of zeros, so there is one report per day of the window. Values are in the native currency:
an issued currency counts at the rate of the day (the `/v2/exchange_rates` rate in strict mode) and as 0 where it has none.
Quotients are cut to 17 significant digits, sums are exact. `payments` adds a list `[{tx_hash, amount (the delivered amount),
currency, issuer?, type}]` as the last key of each report. A payment from the account to itself would count once, as sent (the
original tested the sender's side first), and the account would be among its own `receiving_counterparties`.

Errors, in order: 400 `invalid date format` (`start`, or the path date), `invalid end date format`, `choose a date range less
than 200 days`; 500 `unable to retrieve payments` (the message the original has: it copied the payments route).

**Differences**: the days are the calendar days of the window (a `start` with a time of day gave the original zero rows for
every day); the rate of an issued currency is the rate of the UTC day, not the rate at each payment's time (an approximation
the design accepts); sums are exact.

### `GET /v2/accounts/{address}/stats/{family}`

`family` is `transactions` or `value`. A row per UTC day on which the account was **active** (a day without activity has no
row), from `start` up to but **not including** `end`.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start` | `2013-01-01` | The first day, from its midnight on. |
| `end` | now | Exclusive: `end=2015-01-16` gives the days before it (a day is in when its midnight is at or after `start` and before `end`). If `start` and `end` are less than a whole day apart, `start` is cut back to the start of its day. |
| `descending`, `limit` (200, max 1000), `marker` | | The marker is the day of the last row. |
| `format` | json | `csv`: file `<address> - stats.<family>.csv`. |

The answer is `{ "result": "success", "count": n, "marker": "…", "rows": [ ... ] }`: the list key is **`rows`** (not `stats`).

`family=transactions` rows: `{ "date": "2015-01-14T00:00:00Z", "transaction_count": 3, "result": {"tesSUCCESS": 3}, "type":
{"Payment": 2, "OfferCreate": 1} }` (the transactions the account **sent** that day). `family=value` rows: `{ "date": …,
"account_value": "1034.5", "balance_change_count": 7 }` (what the account held at the end of the day in the native currency:
the native balance plus each issued currency it holds at the rate of the day; a negative issued balance, what the account
owes, is worth 0; `balance_change_count` does not count the fee).

Errors, in order: 400 `invalid start date format`, `invalid end date format`, `invalid family`, `invalid marker`; 500 `unable to
retrieve exchanges` (the original's message, copied from another route).

The account stats were computed by an external job of the original that is not in its repository; the semantics above
(transactions sent, results/types of those, value at the end of the day, fee not counted) are this API's reading of its
README, see [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md).

---

## Active accounts

### `GET /v2/active_accounts/{base}/{counter}`

The accounts that traded a pair in a period, sorted by base volume, the largest first. An account is in the list of the
seller and of the buyer of every trade (an account that trades with itself counts on both sides).

| Parameter | Default | Meaning |
| --- | --- | --- |
| `period` | `1day` | `1day`, `3day` or `7day`, exactly as written. |
| `date` | none | With a date the window runs from it to `period` after it **and then to the end of the unit the date names** (`date=2015-01-14&period=7day` reads `[2015-01-14, 2015-01-22)`, eight days, like the original). Without one it is the `period` before now. |
| `include_exchanges` | false | Any non-empty text: add the trades of each account. |
| `format` | json | `csv`: file `active_accounts.csv`. |

```json
{ "result": "success", "count": 1, "exchanges_count": 12,
  "accounts": [{ "buy":  { "base_volume": "500", "counter_volume": "4.5", "count": 3 },
                 "sell": { "base_volume": "0",   "counter_volume": "0",   "count": 0 },
                 "account": "r…", "base_volume": "500", "counter_volume": "4.5", "count": 3 }] }
```

With `include_exchanges` each account gets a last key `exchanges`, a list of trades without the pair fields and with
`client` when there is one (executed_time with milliseconds); a swap against an AMM pool has `amm_account` as the last key of its
object. A pair asked for in the reverse order is inverted (base and counter, buy and sell swap). Swaps against AMM pools count as
trades (there is no `amm` filter on this route), so the pool account is in the list like any account that traded the pair.

Errors: the pair errors of the exchanges route, then 400 `invalid period - use: 1day, 3day, 7day`, `invalid date format`;
500 `unable to retrieve exchanges`.

**Differences**: the window follows the original's end rule (above); volumes are exact sums; an empty `date=` is no date
(the original failed with a 500); database failures answer 500 (the original hung); `format=csv` works; native-currency legs
`<= 0.0005` are counted (as in the original).

---

## Network

`fees` and `fee_stats` answer `{ "result": "success", "marker": "…", "count": n, "rows": [...] }` (the key order is `result, marker, count, rows`); the three volume routes answer `{ "result": "success", "count": n, "marker": "…", "rows": [...] }`. `marker` is present only when there is a next page.

### `GET /v2/network/fees`

The fees paid by the transactions of a ledger, an hour or a day, in whole units of the native currency.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `interval` | `ledger` | `ledger`, `hour` or `day`. |
| `start` | `2013-01-01` | |
| `end` | the newest ledger | |
| `descending` | false | |
| `limit` | 200 (max 1000) | |
| `marker` | | For `ledger` the ledger index of the last row, otherwise the start of its hour or day. |
| `format` | json | `csv`: file `network fees.csv`. |

An hour or a day is a row when it **starts** within `start` and `end`, and it counts all its ledgers.

```json
{ "result": "success", "marker": "…", "count": 1,
  "rows": [{ "avg": 0.010615, "max": 0.011, "min": 0.00001, "total": 0.138, "tx_count": 13,
             "date": "2015-01-14T18:27:20Z", "ledger_index": 11118827 }] }
```

Key order (the order of the original's HBase row): `avg, max, min, total, tx_count, date, ledger_index`; hour and day rows
have no `ledger_index` and their `date` is the start of the bucket. All amounts are JSON numbers. `avg` of a ledger is the mean
fee to 6 significant digits, rounded to a drop; `avg` of an hour or day is `total / tx_count` rounded to a drop; a ledger or
bucket without transactions has `avg` 0 (and a ledger's `min` is 0).

Errors: 400 `invalid start date format`, `invalid end date format`, `invalid interval`, `invalid marker`; 500 `unable to retrieve
fee summary(s)`.

**Differences from data.ripple.com**: an hour or day with transactions in only some ledgers has a `min` that does not depend on
whether its first ledger was empty; an empty bucket has `avg` 0 where the original had `NaN`/`null`; the rows are computed from
the ledger table at query time (no aggregation job that can lag), so they exist as soon as the ledgers do.

### `GET /v2/network/fee_stats`

Snapshots of the node's fee state (the `fee` command), taken every 5 seconds by the syncer.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `interval` | `raw` | `raw` (every snapshot), `minute`, `hour` or `day`: the **first snapshot at or after each boundary**. |
| `start` | `2016-07-01` | |
| `end` | now | |
| `descending`, `limit` (200, max 1000), `marker` | | |
| `format` | json | `csv`: file `network fee stats.csv`. |

```json
{ "result": "success", "marker": "…", "count": 1,
  "rows": [{ "current_ledger_size": 54, "current_queue_size": 0, "date": "2016-08-24T00:15:55Z",
             "expected_ledger_size": 53, "median_fee": 0.000005, "minimum_fee": 0.00001, "open_ledger_fee": 0.00001,
             "pct_max_queue_size": 0 }] }
```

Key order: `current_ledger_size, current_queue_size, date, expected_ledger_size, median_fee, minimum_fee, open_ledger_fee,
pct_max_queue_size`. Fees are numbers in whole units of the native currency; `pct_max_queue_size` is
`current_queue_size / (expected_ledger_size × 20) × 100` to two decimals.

Errors: 400 `invalid start date format`, `invalid end date format`, `invalid interval`, `invalid marker`; 500 `unable to retrieve
fee summary(s)`.

**Differences**: with an `interval` a bucket serves the first snapshot at or after its boundary (the original needed a row
stored under exactly that second, which only its cron timing guaranteed); a bucket without a snapshot has no row; `interval=raw`
is accepted and means the same as none.

### `GET /v2/network/exchange_volume`, `payment_volume` and `amm_volume`

The trade volume, the payment volume and the AMM volume of the network, converted to the native currency (or to a display currency). The
trade and payment components come from the **markets config** of the network (`packages/shared/config/markets/{xrpl,xahau}.json`, or the file in
`GH_MARKETS_CONFIG`), a versioned list of trade markets and payment currencies that the syncer's aggregator works through; the
list shipped for Xahau (version 3) was derived from a small sample of three days of Xahau history (one trade market, `EVR`/`XAH`, and
three payment currencies; the `XXX` test token is left out): it is provisional and should be re-derived from a full-history node
(override with `GH_MARKETS_CONFIG`).

Two modes, chosen by the parameters:

- **Live** (neither `start` nor `end`): one row for a rolling period ending now. `live` is `hour`, `day`, `3day`, `7day` or
  `30day` for trades and for AMM volume, and `hour` or `day` for payments (default `day`; anything else is 400 `invalid period - use:
  <list>`). The aggregator refreshes these every minute: twelve live sets in all (five periods for each of the trade volume and the AMM
  volume, two for the payments).
- **Historical** (`start` or `end` given): one row per `interval` (`day`, `week` from Monday, `month`, UTC) for the days the
  aggregator has computed. A missing `start` is the epoch, a missing `end` is now. A bucket is a row when it starts within
  `start` and `end`, whole.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `live` | `day` | Live period, ignored when `start` or `end` is given. |
| `start`, `end` | | Historical window. |
| `interval` | `day` | `day`, `week` or `month` (400 `invalid interval - use: day, week, month`). |
| `exchange_currency`, `exchange_issuer` | the native currency | Show the amounts in another currency, at the rate of the live trades (live) or the volume weighted price of the bucket (historical). 400 `exchange currency must have an issuer`, `XRP cannot have an issuer`, `invalid exchange issuer address`. |
| `limit` | 200 (max 1000) | Historical only. |
| `marker` | | Historical only. |
| `format` | json | `csv`: files `trade_volume.csv`, `payment_volume.csv`, `amm_volume.csv`. |

```json
{ "result": "success", "count": 1,
  "rows": [{
    "components": [{ "count": 120, "rate": "0.0090909091", "amount": "5000",
                     "base": { "currency": "USD", "issuer": "r…" }, "counter": { "currency": "XRP" },
                     "converted_amount": "45454.545" }],
    "count": 120, "exchange": { "currency": "XRP" }, "total": "45454.545", "exchange_rate": "1.0000000",
    "start_time": "2026-10-15T12:00:00Z", "end_time": "2026-10-16T12:00:00Z" }] }
```

Row keys: `components, count, exchange, total, exchange_rate, start_time, end_time`. A **trade** component is `{count, rate, amount,
base, counter, converted_amount}`, a **payment** component `{currency, issuer?, amount, count, rate, converted_amount}`
(`issuer` absent for the native currency), an **AMM** component `{amm_account, base, counter, count, amount, rate, converted_amount}`. `amount` is the exact sum in the component's currency, `converted_amount` and
`total` are the value in the native currency (or the display currency), `count` of a row is the number of trades or payments.
Components are sorted by converted amount, the largest first. A component's `rate` is how many units of its currency one native
coin buys (`amount / converted_amount`); a market or currency without a rate is left out of the components (but its payments
count in `count`). Week and month rows add up the converted days (a documented approximation).

**`amm_volume`** is the volume of the swaps against the AMM pools, one component per pool (`amm_account`, its `base` and `counter`, the
number of swaps as `count`, and `amount`, the volume of that `base`). It is not limited to the markets config: every pool with swaps
counts, whatever its assets, and swaps whose native leg is 0.0005 or less are left out. A pool against the native currency has the
native currency as its `counter` (a pool the ledger stores with the native currency first is turned round) and is converted to its own
native volume (its `rate` is its base volume over its native volume); any other pool is converted through the rate of its
base asset and, when that has none, of its counter asset (the sides are then swapped, and `amount` is the counter volume). The rate of an
asset is taken from the markets against the native currency in the same window and, for an asset they have none for, from the AMM
pools against the native currency in the same window. A pool without a rate on either side is left out. The trade volume
(`exchange_volume`) counts the swaps too: `amm_volume` is a view of the pools alone, it does not change that one. **A week or month row
can list a non-native pool twice**, once for each orientation: the days of the bucket that converted the pool through its base and the
days that converted it through its counter are added up apart, because their amounts are of different currencies. On Xahau (no AMM) the
rows have no components and zero totals.

Errors: 400 as above, `invalid start date format`, `invalid end date format`, `invalid marker`; 500 `error getting data`
(also for all three routes).

**Differences from data.ripple.com**: the `amm_volume` route does not exist in the original (an extra); `exchange_volume` includes the swaps against AMM pools in the trades of the configured markets; the `minute` live period of the original's develop branch is **not** supported; component
`rate` follows the semantics above (the original's non-native trade component carried the pair's vwap, so `amount / rate` did
not reproduce `converted_amount`); `converted_amount` is always a string; historical rows carry `end_time` (the start of the
next bucket, exclusive); the historical display currency uses each bucket's own native-to-display price. A day counts as final
only once the ingest has passed it by an hour, so volumes follow the ingest rather than the wall clock.

---

## AMM

GateHub extras: the original predates automated market makers (the XRP Ledger enabled them in March 2024), so none of these endpoints
has a Ripple original. They serve the pools of the AMM, their history and their events, the liquidity positions of an account and the
network volume of the swaps. Xahau has no AMM. The reasons for the design are in
[ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md). A swap against a pool is an exchange and is served by the
[exchange endpoints](#exchanges) too (`amm_account`, the `amm` filter).

Everything below follows the usual contract (the [conventions](#conventions) above: errors, keys, `limit`, markers and `Link`, CSV), with these
rules for the objects, whose shape and key order are ours (Ruling R-A24) and are pinned by tests:

- **Flat keys.** The pair of a pool is `base_currency, base_issuer?, counter_currency, counter_issuer?`, in the canonical order the pool is
  stored in (the same order as the exchanges: lexicographic on the lower-cased `currency+issuer`). The native currency has no issuer key. A
  pool is addressed by its **pool account** (the address of the AMM's pseudo-account); the pair form of the detail route takes the two assets
  in either order.
- **Amounts** (`reserve_*`, `lp_supply`, `volume_*`, ...) are exact decimal strings in whole units. `trading_fee` is a number in units of
  1/100000 (`500` is 0.5%). Times are `YYYY-MM-DDTHH:mm:ssZ`.
- **`value_native`** is the pool's worth in the native currency, a **string** that is a plain decimal of **eight significant digits**
  with the trailing zeros dropped and never in the exponent form (`"123"`, `"12.5"`, `"100000000"`, `"0.0000001"`). It is twice the native
  reserve of a pool that has the native currency; for any other pool twice a reserve over the daily rate of that asset (the units of it one
  native coin buys, the rate the volume routes divide by), the base tried first, then the counter. It is left out when neither asset has a
  rate, and for a deleted pool.
- **The auction slot** is grouped: `auction_slot {holder?, price?, discounted_fee?, expiration?}` (`expiration` a time, `discounted_fee`
  in units of 1/100000), left out when the pool has none of it. `deleted` is a boolean that every pool and state has. A key whose value is
  unknown is left out: `null` is never used, and a fee of 0 is a value.
- **Carried forward.** A pool's state after a transaction holds only the values that transaction's metadata carried (a swap through an
  XRP/IOU pool says nothing of the LP supply, a vote nothing of the reserves). Every value served for a pool or a state is the newest known
  value up to that point. The `*_est` fields are estimates.
- **The CSV** of every list has the same columns on every non-empty page (an empty page is a zero-length body; `null` is an empty cell, the slot is always its four columns,
  `auction_slot.holder`, `auction_slot.price`, ...), in the order of the keys below.
- **Dates and ledgers.** `start` is inclusive, `end` inclusive at its precision, as everywhere; the lists are in the order of the ledgers
  (`descending` reverses it) and read the committed ledgers only.
- **Xahau** answers the lists empty and the pool routes 404 `pool not found`, since there is no pool.

The 404 rule differs between two groups of routes. `GET /v2/amm/pools/{pool}` (and the pair form) is served from the table the aggregator
rebuilds, so **a brand-new pool is 404 there until the next aggregator tick** (up to about a minute). The history, the days, the swaps,
the liquidity and the governance of a pool are found **as soon as the ledger that touched the pool is committed**.

### `GET /v2/amm/pools`

The pools in their current state, the most valuable first.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `asset`, `asset2` | all | Only the pools that have this asset on either side, written like a path asset of the exchanges (`USD+rIssuer`, or the native currency alone; the separators `+`, `\|` and `.` all work). With both, the pools that have both: `asset=XRP&asset2=USD+rIssuer` is the XRP/USD pool. In a query string `%2B` is the strict form of `+`; a raw `+`, which decodes as a space, works too (a space is in no currency code and no address). |
| `include_deleted` | false | Boolean: also the pools that were deleted. |
| `limit` | 200 (max 1000) | |
| `marker` | | |
| `format` | json | `csv`: file `amm pools.csv`. |

```json
{ "result": "success", "count": 1, "marker": "…",
  "pools": [{
    "amm_account": "r…", "base_currency": "USD", "base_issuer": "r…", "counter_currency": "XRP",
    "reserve_base": "1250.5", "reserve_counter": "2500", "lp_supply": "1767.7669", "lp_currency": "03…",
    "trading_fee": 500,
    "auction_slot": { "holder": "r…", "price": "12.5", "discounted_fee": 50, "expiration": "2026-10-18T09:00:00Z" },
    "value_native": "5000", "created_ledger": 107612573, "created_by": "r…", "last_ledger": 107717584, "deleted": false }] }
```

**Pool**, in this order: `amm_account, base_currency, base_issuer?, counter_currency, counter_issuer?, reserve_base?, reserve_counter?,
lp_supply?, lp_currency?, trading_fee?, auction_slot?, value_native?, created_ledger?, created_by?, last_ledger, deleted`. `lp_currency` is the
40-hex-digit currency of the LP token, which the pool issues. `last_ledger` is the newest ledger the pool's state has seen.
`created_ledger` and `created_by` (the sender of the `AMMCreate`) are left out for a pool whose creation was not ingested (a pool first
seen in the middle of its life, before the AMM data was re-ingested from the enablement ledger).

**Order and marker.** `value_native` descending, the pools without a value last, then `amm_account` ascending. The marker holds the value
and account of the last pool. Deleted pools are left out unless asked for. The list is rebuilt by the aggregator about every minute.

Errors, in the order they are checked: 400 for `asset` and then `asset2` (`currency is required`, `XRP cannot have an issuer` (`XAH` on
Xahau), `issuer is required`, `invalid issuer address`; the messages do not name a side), `invalid marker`; 500 `unable to retrieve pools`.

### `GET /v2/amm/pools/{pool}` and `GET /v2/amm/pools/{base}/{counter}`

One pool, `{ "result": "success", "pool": Pool }`: the Pool above. `{pool}` is the pool account. `{base}/{counter}` is the pair, the assets
written as in [`/v2/exchanges/{base}/{counter}`](#get-v2exchangesbasecounter), in either order. A deleted pool is served (`deleted` true,
no `value_native`). When a pair has had several pools (each deleted before the next was created), the pair form serves the **live pool
first and else the one with the highest `last_ledger`**, then the lowest account.

Errors: 400 `invalid pool` (the text is not an address); for the pair form the pair errors of the exchanges route (`base currency is
required`, `counter currency is required`, `XRP cannot have an issuer`, `base issuer is required`, `counter issuer is required`, `invalid
base issuer address`, `invalid counter issuer address`); 404 `pool not found` (there is no such pool, **or the pool was created less than a
minute ago**, see above); 500 `unable to retrieve pool`. No CSV.

### `GET /v2/amm/pools/{pool}/history`

The pool over time: every state it has been in, or with `interval=day` one row for each day it had activity.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `pool` (path) | | The pool account. |
| `start` | the first ledger | |
| `end` | the newest ledger | |
| `interval` | none | Empty or missing: every state. `day`: the days with activity. Anything else is 400 `invalid interval`. |
| `descending` | false | Newest first. |
| `limit` | 200 (max 1000) | |
| `marker` | | |
| `format` | json | `csv`: file `<pool> - amm history.csv` (also with `interval=day`). |

**Every state** (`history`): the pool after each transaction that touched it (a swap, a deposit, a withdrawal, a vote, a bid, the
creation, the deletion), in ledger order. The values are carried forward: a state has the newest value of each column over its own row
and everything before it, **also from before `start`** (the carry-in is read from the ledgers before the page, going back as far as a
column needs). A value the pool never had stays out of the object.

```json
{ "result": "success", "count": 1, "marker": "…",
  "history": [{
    "amm_account": "r…", "ledger_index": 107703707, "tx_index": 12, "tx_hash": "…", "tx_type": "AMMDeposit",
    "executed_time": "2026-10-17T10:24:11Z", "base_currency": "USD", "base_issuer": "r…", "counter_currency": "XRP",
    "reserve_base": "1250.5", "reserve_counter": "2500", "lp_supply": "1767.7669", "lp_currency": "03…", "trading_fee": 500,
    "auction_slot": { "holder": "r…", "price": "12.5", "discounted_fee": 50, "expiration": "2026-10-18T09:00:00Z" },
    "deleted": false }] }
```

**PoolState**, in this order: `amm_account, ledger_index, tx_index, tx_hash, tx_type, executed_time, base_currency, base_issuer?,
counter_currency, counter_issuer?, reserve_base?, reserve_counter?, lp_supply?, lp_currency?, trading_fee?, auction_slot?, deleted`. The
marker holds `ledger_index` and `tx_index`.

**Days** (`interval=day`, the list key is `days`): a UTC day on which a transaction touched the pool, with the stats of the day and the
closing state of the pool.

```json
{ "result": "success", "count": 1, "marker": "…",
  "days": [{
    "amm_account": "r…", "date": "2026-10-16T00:00:00Z", "base_currency": "USD", "base_issuer": "r…", "counter_currency": "XRP",
    "swap_count": 120, "volume_base": "340.5", "volume_counter": "680.9", "fees_base_est": "0.85", "fees_counter_est": "1.7",
    "deposit_count": 2, "withdraw_count": 1, "liquidity_in_base": "10", "liquidity_in_counter": "20",
    "liquidity_out_base": "5", "liquidity_out_counter": "10", "reserve_base": "1250.5", "reserve_counter": "2500",
    "lp_supply": "1767.7669", "trading_fee": 500, "value_native": "5000" }] }
```

**PoolDay**, in this order: `amm_account, date, base_currency, base_issuer?, counter_currency, counter_issuer?, swap_count, volume_base,
volume_counter, fees_base_est?, fees_counter_est?, deposit_count, withdraw_count, liquidity_in_base, liquidity_in_counter,
liquidity_out_base, liquidity_out_counter, reserve_base?, reserve_counter?, lp_supply?, trading_fee?, value_native?`. `date` is the start of
the UTC day. `volume_base` and `volume_counter` are the amounts that **went into the pool**, by side, over the day's swaps; `fees_*_est` are
**estimates**: each swap's input times the pool's trading fee at that point (or the auction slot's discounted fee when the taker is the
slot holder or one of its authorized accounts and the slot has not expired), over 100000. An estimate is **left out when a swap into its
side had no known fee** (a pool first seen in the middle of its life, before a transaction showed its fee: the sum of the other swaps
would understate it), and is `"0"` when every swap into its side had a known fee of 0 or there was none; the CSV cell is then empty.
`liquidity_in_*` and `liquidity_out_*` are the
amounts deposited and withdrawn (a creation counts as a deposit, a clawback as a withdrawal). The reserves, `lp_supply`, `trading_fee`
and `value_native` are those at the end of the day (a pool deleted during the day has none, and no value). The marker is the start of
the last day, in unix seconds.

**The window of the days.** A day is a row when its **start** (00:00 UTC) is within `start` and `end`: at or after `start`, and before
the end of the period `end` names. So `start=2026-10-01&end=2026-10-03` gives up to three days, and a `start` with a time of day leaves out
the day it falls in. The days are the ones the aggregator has computed (today is refreshed about every five minutes; see
[syncer](syncer.md#the-amm-jobs)); a day without activity has no row.

**Empty and 404.** A page with no rows is 200 with an empty list when the pool has a state in a committed ledger (a pool with states but
no day yet answers an empty `days`), and 404 `pool not found` when it has none.

CSV: the same columns on every non-empty page, in the order of the keys, the slot as `auction_slot.holder, auction_slot.price,
auction_slot.discounted_fee, auction_slot.expiration`; with `interval=day` the PoolDay columns.

Errors, in the order they are checked: 400 `invalid pool`, `invalid start date format`, `invalid end date format`, `invalid interval`,
`invalid marker`; then 404 `pool not found`; 500 `unable to retrieve pool history`.

### `GET /v2/amm/pools/{pool}/swaps`

The exchanges that were swaps against this pool, oldest first: what [`GET /v2/exchanges/{base}/{counter}?amm=only`](#get-v2exchangesbasecounter)
serves for the pool's pair, restricted to the pool. The rows, the key order (with `amm_account` last), the markers and the CSV are those
of the exchanges, in the pair as the pool stores it (the pair of `GET /v2/amm/pools/{pool}`), with no inversion. As there, the amounts are
the pool's own changes, which on the asset the pool pays out include the issuer's transfer fee ([Exchanges](#exchanges)).

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start` | `2013-01-01` | |
| `end` | the newest ledger | |
| `autobridged` | false | Only the autobridged swaps. |
| `descending` | false | |
| `limit` | 200 (**max 400**) | As the exchanges: a text that is not a number is 400 `invalid limit: NaN`. |
| `marker` | | |
| `format` | json | `csv`: file `<pool> - amm swaps.csv`, the exchange columns and `amm_account` last. |

`{ "result": "success", "count": n, "marker": "…", "exchanges": [Exchange, …] }`. **`amm` is ignored** here: these are always the swaps,
and no value of the parameter changes that (so `amm=bogus` is not an error on this route). A pool with no swap in the window is 200 with an empty
list; the 404 rule is the one of the states (see above), so a pool is found as soon as its ledger is committed. Reads go through the pair key
of the pool and the skip index on the pool column, never across pairs.

Errors, in the order they are checked: 400 `invalid pool`, `invalid start date format`, `invalid end date format`, `invalid limit: NaN`,
`invalid marker`; then 404 `pool not found`; 500 `unable to retrieve swaps`.

### `GET /v2/amm/pools/{pool}/liquidity`

The creation, the deposits, the withdrawals, the clawbacks and the deletion of the pool, oldest first.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | the first ledger, the newest | |
| `event` | all | `create`, `deposit`, `withdraw`, `clawback` or `delete`, spelt exactly so; empty is none; anything else is 400 `invalid event`. |
| `account` | all | Only the events of this liquidity provider (not validated: an address that has none gives an empty list). |
| `descending`, `limit` (200, max 1000), `marker` | | |
| `format` | json | `csv`: file `<pool> - amm liquidity.csv`. |

```json
{ "result": "success", "count": 1, "marker": "…",
  "liquidity": [{
    "amm_account": "r…", "ledger_index": 107703707, "tx_index": 12, "tx_hash": "…", "executed_time": "2026-10-17T10:24:11Z",
    "account": "r…", "initiator": "r…", "event": "deposit", "mode": "two_asset",
    "base_amount": "10", "counter_amount": "20", "lp_tokens": "14.1421356" }] }
```

**LiquidityEvent**, in this order: `amm_account, ledger_index, tx_index, tx_hash, executed_time, account, initiator, event, mode?,
base_amount, counter_amount, lp_tokens`. The amounts are **signed, from the pool's side**: positive came into the pool, negative went out
(a withdrawal has negative amounts), on the pool's `base` and `counter` (the pair of `GET /v2/amm/pools/{pool}`: the event carries no pair).
`lp_tokens` is positive when LP tokens were minted and negative when they were burned. `account` is the liquidity provider and
`initiator` the account that sent the transaction (the two differ for a clawback: `account` is the holder, `initiator` the issuer).
`mode` is the one mode flag of a deposit or withdrawal (deposits: `lp_token`, `single_asset`, `two_asset`, `one_asset_lp_token`,
`limit_lp_token`, `two_asset_if_empty`; withdrawals: `lp_token`, `withdraw_all`, `one_asset_withdraw_all`, `single_asset`, `two_asset`,
`one_asset_lp_token`, `limit_lp_token`); it is left out for a creation, a deletion, a clawback, and a transaction with no mode flag or
several. A withdrawal that empties the pool deletes it and is a `withdraw` event. The marker holds `ledger_index` and `tx_index`. In the
CSV every column is there and `mode` is an empty cell where the object has none. `event` and `account` are conditions of the read itself,
so a page is full whatever the share of events that match.

Errors, in the order they are checked: 400 `invalid pool`, `invalid start date format`, `invalid end date format`, `invalid event`,
`invalid marker`; then 404 `pool not found`; 500 `unable to retrieve liquidity`.

### `GET /v2/amm/pools/{pool}/governance`

The votes on the trading fee and the bids for the auction slot, oldest first.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | the first ledger, the newest | |
| `type` | all | `vote` or `bid`; empty is none; anything else is 400 `invalid type`. |
| `descending`, `limit` (200, max 1000), `marker` | | |
| `format` | json | `csv`: file `<pool> - amm governance.csv`. |

```json
{ "result": "success", "count": 2, "marker": "…",
  "governance": [
    { "amm_account": "r…", "ledger_index": 107644916, "tx_index": 7, "tx_hash": "…", "executed_time": "2026-10-16T08:00:00Z",
      "type": "vote", "account": "r…", "fee_voted": 300, "trading_fee_after": 450 },
    { "amm_account": "r…", "ledger_index": 107650001, "tx_index": 3, "tx_hash": "…", "executed_time": "2026-10-16T09:00:00Z",
      "type": "bid", "account": "r…", "bid_min": "1", "bid_max": "5", "price_paid": "2.5",
      "auction_slot": { "holder": "r…", "discounted_fee": 50, "expiration": "2026-10-17T09:00:00Z", "auth_accounts": ["r…"] } }] }
```

**Vote** (`type` `vote`), in this order: `amm_account, ledger_index, tx_index, tx_hash, executed_time, type, account, fee_voted?,
trading_fee_after?`: the fee the voter asked for and the pool's fee after the vote. **Bid** (`type` `bid`): `amm_account, ledger_index,
tx_index, tx_hash, executed_time, type, account, bid_min?, bid_max?, price_paid?, auction_slot?`, where `price_paid` is the LP tokens the
bid burned and `auction_slot {holder?, discounted_fee?, expiration?, auth_accounts}` is the slot after the bid (`auth_accounts` always a
list, empty when the slot has none). A vote carries nothing of a bid and a bid nothing of a vote. The marker holds `ledger_index` and
`tx_index`.

The CSV has the columns of both kinds, in this order: `amm_account, ledger_index, tx_index, tx_hash, executed_time, type, account,
fee_voted, trading_fee_after, bid_min, bid_max, price_paid, auction_slot.holder, auction_slot.discounted_fee, auction_slot.expiration,
auction_slot.auth_accounts`; the accounts of `auction_slot.auth_accounts` are one cell, joined by `;`. `type` is a condition of the read
itself.

Errors, in the order they are checked: 400 `invalid pool`, `invalid start date format`, `invalid end date format`, `invalid type`,
`invalid marker`; then 404 `pool not found`; 500 `unable to retrieve governance`.

### `GET /v2/accounts/{address}/amm_liquidity`

The liquidity events of an account across all pools, oldest first. The address is not validated: one that is none has no events.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | the first ledger, the newest | |
| `pool` | all | Only the events of the pool with this account: an address (empty is none), else 400 `invalid pool`; it need not be a pool that exists. |
| `event` | all | As on the pool route (400 `invalid event`). |
| `descending`, `limit` (200, max 1000), `marker` | | The marker holds `ledger_index`, `tx_index` and the pool. |
| `format` | json | `csv`: file `<address> - amm liquidity.csv`. |

`{ "result": "success", "count": n, "marker": "…", "liquidity": [LiquidityEvent, …] }`: the events of the pool route, with the
same key order and signs. There is no 404. Errors, in the order they are checked: 400 `invalid start date format`, `invalid end date
format`, `invalid pool`, `invalid event`, `invalid marker`; 500 `unable to retrieve liquidity`.

### `GET /v2/accounts/{address}/amm_positions`

The LP-token positions of an account, one for each pool in which it holds LP tokens. The address is not validated.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `date` | now | The moment the positions are as of. Empty is none. It names an **instant**, not the end of the period: `2026-10-17` is midnight at the start of that day. It is resolved to the last committed ledger that closed at or before it (never past the newest one). A date before the first stored ledger gives no positions. |

```json
{ "result": "success",
  "positions": [{ "pool": "r…", "lp_currency": "03…", "lp_balance": "100", "share": "0.25",
                  "base_amount": "312.625", "counter_amount": "625" }] }
```

**Position**, in this order: `pool, lp_currency, lp_balance, share, base_amount?, counter_amount?`, sorted by pool. `lp_balance` is the
account's last balance of the pool's LP token at that ledger, `share` is `lp_balance / lp_supply` with the supply of the pool at the same
ledger, and each amount is `lp_balance × reserve / lp_supply` for the `reserve_base` and `reserve_counter` of the pool at that ledger (the
pair of `GET /v2/amm/pools/{pool}`). They are **exact decimals**, never floats and never in the exponent form: a quotient that ends is
served whole, however many digits it has, and one that does not end is rounded (half up) to **30 significant digits**. An amount whose
reserve is unknown has no key. A line that is not a position is left out: a zero balance, a pool that was **deleted** by that ledger or
whose supply is 0 or unknown, an account that is not a pool, and a line whose currency is not the LP currency the pool names. The list is
not paged (no `count`, `marker` or CSV).

Errors: 400 `invalid date format`; 500 `unable to retrieve positions`.

---

## Validations

### `GET /v2/ledgers/{ledger_hash}/validations` and `GET /v2/ledger/{ledger_hash}/validations`

The validations the network made of one ledger, one per validator, sorted by validator key. The singular `/v2/ledger/...` is an
alias: the original's README documented that spelling (its route table did not), and it is provided on request. The data are collected by the syncer from the `validations` stream of `GH_VALIDATION_ENDPOINTS`
and kept for 90 days.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `ledger_hash` (path) | | Hex of even length (a leading `0x` is accepted and dropped); upper-cased. |
| `limit` | 200 (max 1000) | |
| `marker` | | The validator public key of the last row. |
| `format` | json | `csv`: file `<ledger_hash> - validations.csv`. |

```json
{ "result": "success", "ledger_hash": "A1B2…", "count": 1, "marker": "n9…",
  "validations": [{
    "count": 3, "first_datetime": "2026-10-16T12:00:01.123Z", "flags": "2147483649", "full": "true",
    "last_datetime": "2026-10-16T12:00:02.456Z", "ledger_hash": "A1B2…", "ledger_index": "107695660",
    "reporter_public_key": "n9…", "signing_time": "814567890", "validation_public_key": "n9…" }] }
```

A validation's keys are the stored columns in alphabetical order (as the original's row came): `amendments?, base_fee?, count,
ephemeral_public_key?, first_datetime, flags, full?, last_datetime, ledger_hash, ledger_index, load_fee?, reporter_public_key?,
reserve_base?, reserve_inc?, signature?, signing_time, validation_public_key`. Values are **text** (`flags`, `ledger_index`,
`signing_time`, the fees, `full: "true"`), except `count` (a number); an empty column is absent. `first_datetime` and
`last_datetime` are the first and last time a collector saw the validation; `count` is how often.

### `GET /v2/ledgers/{ledger_hash}/validations/{pubkey}`

The validation of the ledger by one validator, as the flat object above plus `result`:
`{ "count": 3, …, "validation_public_key": "n9…", "result": "success" }`. JSON only (`format` is ignored). 404 `validation not
found`.

Errors of both: 400 `invalid ledger hash`, `invalid marker`; 500 `unable to retrieve ledger`.

**Differences from data.ripple.com**: a hash with a `0x` prefix works (the original upper-cased it to `0X...` and never matched);
validations are kept **per (ledger, validator)**, not per reporting node: a validation that two collector nodes saw is one row
whose `count` adds up (the original's mock data mixed both shapes); `limit` of 0 or less is the default; a database failure is a
500 `unable to retrieve ledger`.

---

## Stats

### `GET /v2/stats[/{family}[/{metric}]]`

Counts of what happened on the network per hour, day or week (Monday to Sunday, UTC). Without a family a row is the whole
picture, with a family it is a flat row of that family.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `family` (path or query) | none | `type` (transactions by type), `result` (by result code) or `metric` (see below), lower-cased. |
| `metric` (path), `metrics` (query, comma separated) | all of the family | Names within the family. `metrics` needs a family (400 `family is required`). |
| `interval` | `day` | `hour`, `day` or `week`. |
| `start` | `2013-01-01` | |
| `end` | now | |
| `descending` | false | |
| `limit` | 200 (max 1000) | |
| `marker` | | The start of the last bucket. |
| `format` | json | `csv`: file `stats[ family][-family:metric...].csv`. |

The `metric` family has: `accounts_created, exchanges_count, ledger_count, ledger_interval, payments_count, transaction_count,
tx_per_ledger` (`ledger_interval` is the average seconds between ledgers, `tx_per_ledger` the average transactions per ledger,
both to 5 significant digits). `exchanges_count` counts the order-book trades and the swaps against AMM pools. A bucket is listed when it starts within `start` and `end`.

`ledger_interval` is computed from the **start of the bucket**: (close time of its last ledger − bucket start) / its ledgers. That is
the average interval for a complete bucket and for the bucket in progress, but not for the first bucket of a database whose first
ledger closed after the bucket started (the live syncer began, or a backfill begins, part-way through that hour or day): there the
time before the first stored ledger counts too and the value is too high (for example 17.6 instead of about 3.9 for an XRPL hour
whose first 47 minutes are not stored).

```json
{ "result": "success", "count": 1, "marker": "…",
  "stats": [{ "date": "2015-01-14T00:00:00Z",
              "type": { "OfferCreate": 4000, "Payment": 3000 },
              "result": { "tecUNFUNDED_OFFER": 100, "tesSUCCESS": 6900 },
              "metric": { "accounts_created": 12, "ledger_count": 24000, "payments_count": 2900, "transaction_count": 7000 } }] }
```

`/v2/stats/type` (or `?family=type`) gives `{ "OfferCreate": 4000, "Payment": 3000, "date": "…" }`, and
`/v2/stats/result/tesSUCCESS` only that column. **Zero counts are left out**, names are sorted, and a bucket that has none of the
requested columns is not a row.

Errors, in the order they are checked: 400 `family is required`, `invalid start date format`, `invalid end date format`,
`invalid family, use: type, result, metric`, `invalid interval`, `invalid marker`; 500 `unable to retrieve stats`.

**Differences**: an `interval` other than hour, day or week is 400 `invalid interval` (a fix); the rows come from an hourly rollup that
the syncer's aggregator keeps (the last two hours every minute, plus any range ingest rewrote); right after a long outage or
on a database with years of history the current hour can lag until the aggregator has caught up
(`syncer_aggregator_stats_lag_seconds`).

---

## Operational endpoints

Not under `/v2`, no API key, never rate limited:

| Path | Port | Meaning |
| --- | --- | --- |
| `GET /liveliness/healthz` | API port (3001) | 200 when ClickHouse answers a ping, otherwise 503 (terminus format `{status, info, error, details}`). Also on the syncer (3002), where it adds the ingest lag, see [observability](observability.md). |
| `GET /metricz` | metrics port (3000) | Prometheus metrics. Reachable inside the network only, never publish it. |
| `GET /internal/docs`, `/internal/docs-json` | API port | Swagger UI and the OpenAPI JSON. The shipped nginx does not expose `/internal/` or `/liveliness/` to the public. |

