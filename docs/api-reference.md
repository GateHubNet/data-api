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
[Active accounts](#active-accounts) · [Network](#network) · [AMM](#amm) · [Validations](#validations) ·
[Validators and amendments](#validators-and-amendments) · [Stats](#stats) · [Operational endpoints](#operational-endpoints)

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

A key listed in `GH_RATE_LIMIT_KEYS` is counted per key and route, with its own limit, instead of per client address:
`X-RateLimit-Limit` (and `-Remaining`) carry that limit. The 429 body and `Retry-After` are unchanged.

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
| `amm` (the exchange lists, `network/markets`) | `include` (default, also when missing or empty), `exclude` or `only`; case-sensitive. Anything else answers 400 `invalid amm filter - use: include, exclude, only`. See [Exchanges](#exchanges) and [`network/markets`](#get-v2networkmarkets). |
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
live routes `/balances` and `/orders` send their own (see there), and so do the validator routes (see [Validators and amendments](#validators-and-amendments)).
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

Endpoints that exist here and not in the original: `GET /v2/exchanges` (the exchanges of all pairs), the [AMM](#amm) endpoints (`/v2/amm/pools...`,
`/v2/accounts/{address}/amm_liquidity`, `/v2/accounts/{address}/amm_positions`, `/v2/network/amm_volume`), `GET /v2/network/amendments` and
`GET /v2/network/amendments/{name}` (the original had no amendment routes), `GET /v2/network/validators/summary` and
`GET /v2/network/validators/{key}/validations`, and `format=csv` on `GET /v2/accounts/{address}/transactions` (a summary row per transaction,
[ADR-0010](adr/0010-ripple-v2-wire-compatibility.md) item 54). `GET /v2/network/validators[/{key}]` exists in the original and is served differently here: a
trusted-UNL scope, paging, a different order and row, agreement against the indexed chain (see
[Validators and amendments](#validators-and-amendments), [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md) and [ADR-0012](adr/0012-validators-and-amendments-data.md)).
Exchange-based endpoints also differ in what they count: **swaps against AMM pools are exchanges here** (the original predates AMMs), see
[Exchanges](#exchanges) and [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md#6-amm-swaps-are-exchanges-adr-0011).

More additions, from the account and market aggregates ([ADR-0013](adr/0013-account-and-market-aggregates.md)): the routes `GET /v2/accounts/{address}/analytics/{balances,
balance_changes, counterparties, exchanges}` and `GET /v2/network/markets`, and the parameter `interval` on
`GET /v2/accounts/{address}/stats/{family}` and `GET /v2/accounts/{address}/reports` (the original ignored it there: a client that sent
one now gets buckets). Their AMM data additions add the parameter `amm` and the fields `amm_share` and `amm_pool` to `GET /v2/network/markets`, the
fee estimates `fees_est` to the live day row of `GET /v2/network/amm_volume`, and `computed_start` and `computed_end` to `GET /v2/amm/pools/{pool}/history?interval=day`.

From the account investigation data ([ADR-0014](adr/0014-address-names-and-labels-in-a-shared-database.md)): the fields `account_name` of
`GET /v2/accounts/{address}`, the name the operator gave the address, and `account_network_name`, the name the operator gave the account on
this network only.

**Out of scope.** The original served more than the endpoint set this API was asked to implement. These routes of the original
(`api/server.js` of the `master` branch) are **not part of this API and answer 404** `{"result":"error","message":"Cannot GET ..."}`:

| Group | Routes of the original |
| --- | --- |
| Health, gateways, currencies | `/v2/health[/{aspect}]`, `/v2/gateways[/{gateway}]`, `/v2/gateways/{gateway}/assets[/{filename}]`, `/v2/currencies[/{currencyAsset}]` |
| Network | `/v2/network/external_markets`, `/v2/network/xrp_distribution`, `/v2/network/top_markets[/{date}]`, `/v2/network/top\_currencies[/{date}]`, `/v2/network/topology`, `/v2/network/topology/nodes[/{pubkey}]`, `/v2/network/topology/links`, `/v2/network/validators/{pubkey}/manifests`, `/v2/network/validators/{pubkey}/reports`, `/v2/network/validator_reports`, `/v2/network/rippled_versions` (of the validators routes only these four are out of scope: `/v2/network/validators[/{pubkey}]` is served, see [Validators and amendments](#validators-and-amendments)) |
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

The latest activation of the account, the name the operator gave its address and the name it gave the account on this network.

```json
{ "result": "success",
  "account_data": { "account": "r…", "parent": "r…", "initial_balance": "100", "inception": "2015-01-14T18:27:20Z",
                    "ledger_index": 11119603, "tx_hash": "…", "account_name": "GateHub",
                    "account_network_name": "USD Issuer" } }
```

Key order: `account, parent, initial_balance, inception, ledger_index, tx_hash, genesis_balance?, genesis_index?,
account_name?, account_network_name?`.

- `account_name`: the **account name** of the address ([ADR-0014](adr/0014-address-names-and-labels-in-a-shared-database.md)),
  the same on every network. The operator writes it into the shared database by hand
  ([operations](operations.md#name-an-address)); the api loads the names every 60 s (`GH_NAMES_AND_LABELS_RELOAD_MS`), so a
  new or removed name shows within that time. Left out when the address has none.
- `account_network_name`: the **account network name** of the account, its name on this network only ("USD Issuer" for
  GateHub's issuing address on the XRP Ledger, which Xahau does not show). The operator writes it into the network's own
  database by hand ([operations](operations.md#name-an-account-on-one-network)); it is loaded and reloaded with the names (60 s).
  It is served with or without an `account_name`, and left out when the account has none.

The names do not make an account: an address with a name but no activation on this network still answers 404. Errors: 404
`Account not found`; 500 `unable to get accounts`.

**Differences from data.ripple.com** (both routes): an address that was created more than once (deleted with `AccountDelete`
and funded again) answers with its **latest** creation; the original answered with the earliest. A transaction that creates
several accounts is listed once per account (the original kept the last). `GET /v2/accounts/{address}` adds `account_name` and
`account_network_name`, GateHub extras ([ADR-0010](adr/0010-ripple-v2-wire-compatibility.md#amendment-4-2026-10-24-account-investigation-data)
items 55 and 58).

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
| `format` | json | `csv`: one **summary row** per transaction instead of the transaction object, file `<address> - transactions.csv`. Every other parameter applies as in JSON, and the pages follow the same `marker` and `Link` header. `binary` does not change the CSV. |

Errors: 400 `invalid start date format`, `invalid end date format`, `invalid min_sequence`, `invalid max_sequence`, `invalid
transaction type`, `invalid transaction result`, `invalid marker`; 500 `unable to retrieve transactions`. Errors stay JSON with
`format=csv`.

**The CSV summary row** says what the transaction was from the account's side, readable without opening `tx` and `meta`. The
columns, the same on every page and in this order:

| Column | Meaning |
| --- | --- |
| `hash`, `ledger_index` | The transaction and its ledger. |
| `executed_time` | The close time of the ledger, as the `date` of the JSON list (`2015-01-14T18:27:10+00:00`). |
| `tx_type`, `result` | `Payment`, `tesSUCCESS`, ... |
| `initiator` | `true` when the account sent the transaction (its `Account`), `false` when the transaction only affected it. |
| `counterparty`, `amount`, `currency`, `issuer` | From one mapping per transaction type, below. Empty where the type has none. |
| `fee` | The fee in whole units of the native currency, on the transactions the account sent; empty on the others. |
| `flags_changed` | The account flags the transaction set or cleared. Empty for now: it fills once the account state history is recorded. |

| Type | `counterparty` | `amount`, `currency`, `issuer` |
| --- | --- | --- |
| `Payment` | The destination for the sender, the sender for the destination. | The delivered amount of a successful payment, as `/v2/accounts/{address}/payments` gives it (a partial payment from before the fix gives `Amount`; an `Amount.issuer` that names a party is resolved through the trust lines). A failed payment delivered nothing and leaves them empty. An account that is neither party (an issuer the payment rippled through, the owner of an offer it took) gets none of the four. |
| `TrustSet` | The peer of the trust line: the `LimitAmount` issuer for the sender, the sender for that issuer. | The limit the sender set, with its currency and issuer. |
| any other (`OfferCreate`, `AccountSet`, ...) | empty | empty |

Amounts are exact decimal strings in whole units, as on the ledger; the native currency is `XRP` or `XAH` and has no issuer.
A page with no transactions is an empty file.

```csv
"hash","ledger_index","executed_time","tx_type","result","initiator","counterparty","amount","currency","issuer","fee","flags_changed"
"91F79AC2…","11119601","2015-01-14T18:27:10+00:00","Payment","tesSUCCESS","true","r4L6Z…","2","EUR","rMwjY…","0.012",""
```

### `GET /v2/accounts/{address}/transactions/{sequence}`

The transaction the account sent with that `Sequence`, as `{ "result": "success", "transaction": {...} }` (`binary` is
supported). A transaction that used a ticket has Sequence 0: the latest of them is returned. 400 `invalid sequence number`;
404 `transaction not found`; 500 `unable to retrieve transaction`.

**Differences from data.ripple.com** (both routes): `max_sequence` is inclusive (the HBase scan dropped its row); `type` and
`result` are validated against the network definitions; a `min_sequence` above what a sequence can be gives an empty list and
a `max_sequence` above it is clamped, instead of a database error; `/{sequence}` above it is 404. The original had no CSV for
account transactions; `format=csv` with the summary row is a GateHub extra.

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
| `interval` | `day` | `day`, `week` or `month`: a report per bucket (see [`interval` on `reports`](#interval-on-reports) below). |
| `accounts` (alias `counterparties`) | false | List the counterparties instead of counting them. |
| `payments` | false | List the payments of each day. |
| `descending` | false | Newest day first. |
| `format` | json | `csv`: file `<address> - reports.csv` (counterparty lists joined with `, `). |

The window may span at most 200 days (counted as the whole days between `start` and `end`); with an `interval`, at most 200 buckets.

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

Errors, in order: 400 `invalid date format` (`start`, or the path date), `invalid end date format`, `invalid interval - use: day,
week, month`, `choose a date range less than 200 days` (`weeks`, `months`), `payments can only be listed with interval day`; 500
`unable to retrieve payments` (the message the original has: it copied the payments route).

**Differences**: the days are the calendar days of the window (a `start` with a time of day gave the original zero rows for
every day); the rate of an issued currency is the rate of the UTC day, not the rate at each payment's time (an approximation
the design accepts); sums are exact.

#### `interval` on `reports`

Added by [ADR-0013](adr/0013-account-and-market-aggregates.md); the original ignored it, and without it the answers above are
unchanged. `interval` is `day` (the default), `week` (from Monday) or `month` (calendar), all UTC; anything else answers 400
`invalid interval - use: day, week, month`. A report is then a **bucket**, from the bucket of `start` to the bucket of `end`
(`/{date}` gives the one bucket that holds the date); `date` is the start of the bucket, the bucket is whole although the window ends in
the middle of it (the days to come have no payments), and the answer's `start` and `end` are the request's.

- **The limit is 200 buckets**, counted between the bucket of `start` and the bucket of `end`: 200 days with `day` (unchanged: `choose
  a date range less than 200 days`), 200 weeks with `week` (about 3.8 years: `choose a date range less than 200 weeks`) and 200
  months with `month` (about 16.7 years, all of the history: `choose a date range less than 200 months`).
- A bucket's report adds its days up: the totals are the sums of the days' values (each payment at its own day's rate), the highs the
  largest of the days', the payment counts sums. The counterparties are counted (or, with `accounts`, listed in the order of their
  first payment in the bucket) over the whole bucket, not added per day: an account paid on two days of a week is one.
- `payments=true` lists every payment of each report, which a week or a month would make unbounded: with `week` or `month` it is 400
  `payments can only be listed with interval day`.

The checks come in this order: `invalid date format` (the path date, or `start`), `invalid end date format`, `invalid interval - use:
day, week, month`, the window length, then `payments`. The payments are read on read for every account (a payment is not rolled
up), and the rates come from `native_rates_daily` where the day has a set and are worked out on read for the others (as for
`stats/value`).

Example: the buckets of January and February: the window starts in the middle of January and ends on February 20, and
the reports are whole months. The 20 and 10 USD received in February are worth 10 and 5 XRP at the rate of their days, so the
largest of them (`high_value_received`) is 10; an account that was paid on two days of a month (here, in February, the one
the account paid 4 XRP and 8 USD) is counted once:

`GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/reports?interval=month&start=2020-01-15&end=2020-02-20`

<!-- d2-example GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/reports?interval=month&start=2020-01-15&end=2020-02-20 -->

```json
{
  "result": "success",
  "start": "2020-01-15T00:00:00Z",
  "end": "2020-02-20T00:00:00Z",
  "count": 2,
  "reports": [
    {
      "account": "rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD",
      "date": "2020-01-01T00:00:00Z",
      "high_value_received": "7",
      "high_value_sent": "10",
      "total_value_received": "7",
      "total_value_sent": "17",
      "total_value": "24",
      "payments_sent": 3,
      "payments_received": 1,
      "receiving_counterparties": 2,
      "sending_counterparties": 1
    },
    {
      "account": "rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD",
      "date": "2020-02-01T00:00:00Z",
      "high_value_received": "10",
      "high_value_sent": "4",
      "total_value_received": "15",
      "total_value_sent": "8",
      "total_value": "23",
      "payments_sent": 2,
      "payments_received": 2,
      "receiving_counterparties": 1,
      "sending_counterparties": 1
    }
  ]
}
```

### `GET /v2/accounts/{address}/stats/{family}`

`family` is `transactions` or `value`. A row per UTC day on which the account was **active** (a day without activity has no
row), from `start` up to but **not including** `end`; with `interval`, a row per bucket of days, see [`interval` on `stats/{family}`](#interval-on-statsfamily) below.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start` | `2013-01-01` | The first day, from its midnight on. |
| `end` | now | Exclusive: `end=2015-01-16` gives the days before it (a day is in when its midnight is at or after `start` and before `end`). If `start` and `end` are less than a whole day apart, `start` is cut back to the start of its day. |
| `interval` | none | `day`, `week` or `month`: the rows are buckets, not active days (see [`interval` on `stats/{family}`](#interval-on-statsfamily) below). |
| `descending`, `limit` (200, max 1000), `marker` | | The marker is the day of the last row. |
| `format` | json | `csv`: file `<address> - stats.<family>.csv`. |

The answer is `{ "result": "success", "count": n, "marker": "…", "rows": [ ... ] }`: the list key is **`rows`** (not `stats`).

`family=transactions` rows: `{ "date": "2015-01-14T00:00:00Z", "transaction_count": 3, "result": {"tesSUCCESS": 3}, "type":
{"Payment": 2, "OfferCreate": 1} }` (the transactions the account **sent** that day). `family=value` rows: `{ "date": …,
"account_value": "1034.5", "balance_change_count": 7 }` (what the account held at the end of the day in the native currency:
the native balance plus each issued currency it holds at the rate of the day; a negative issued balance, what the account
owes, is worth 0; `balance_change_count` does not count the fee).

Errors, in order: 400 `invalid start date format`, `invalid end date format`, `invalid family`, `invalid interval - use: day, week,
month`, `invalid marker`; 500 `unable to retrieve exchanges` (the original's message, copied from another route).

The account stats were computed by an external job of the original that is not in its repository; the semantics above
(transactions sent, results/types of those, value at the end of the day, fee not counted) are this API's reading of its
README, see [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md).

#### `interval` on `stats/{family}`

Added by [ADR-0013](adr/0013-account-and-market-aggregates.md); the original ignored it, and without it the answers above are
unchanged. `interval` is `day`, `week` (Monday to Monday) or `month` (calendar), all UTC; anything else answers 400 `invalid
interval - use: day, week, month` (checked after the family and before the marker; an empty `interval` is none). The rows are then
**buckets**: a bucket is a row when its start is at or after `start` and before `end` (the rule for days, applied to bucket
starts, and `end` stays exclusive, so `start=2020-01-15&interval=month` has no January row). `date` is the start of the bucket and
the marker is that day (`YYYY-MM-DD`, the existing marker format); `descending` and `limit` count buckets.

- `family=transactions`: a row for each bucket in which the account sent a transaction, with the counts of the whole bucket. A
  bucket without one has no row, as a day has none.
- `family=value`: a row for **every** bucket from the first one in which the account had a balance (the bucket of its first
  balance change, or the first bucket of the window when it changed before) to the last bucket before `end` that has begun (see the next item), active or not: a
  value exists at every bucket end and moves with the rates. `account_value` is the value at the end of the bucket's last day
  (today, for the bucket that holds now) at that day's rates, in the native currency; `balance_change_count` counts the changes of
  the bucket, the fee not counted (0 for a quiet bucket).
- No row of `value` is served for a bucket that has not begun: the rows end at the bucket that holds now, whatever `end` says (a window wholly in the future has no
  row; `transactions` is not affected: a bucket in which the account sent nothing has no row anyway). No bucket that
  starts after 2149-06-06 (the last day a ClickHouse `Date` holds) is served.

Paging is unchanged (`limit` 200, at most 1000): the whole history of an account per month is about 170 rows, one page. A heavy
account (1,000,000 balance changes or more) is read from its daily rollups ([syncer](syncer.md#74-account_rollups)); the answer is
the same with or without them.

Example: the weeks of January 13 and 27 and of February 3 (the week of January 20 had no transaction, so it has no row):

`GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/stats/transactions?interval=week&start=2020-01-13&end=2020-02-10`

<!-- d2-example GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/stats/transactions?interval=week&start=2020-01-13&end=2020-02-10 -->

```json
{
  "result": "success",
  "count": 3,
  "rows": [
    {
      "date": "2020-01-13T00:00:00Z",
      "transaction_count": 3,
      "result": { "tesSUCCESS": 3 },
      "type": { "Payment": 2, "TrustSet": 1 }
    },
    {
      "date": "2020-01-27T00:00:00Z",
      "transaction_count": 1,
      "result": { "tecUNFUNDED_OFFER": 1 },
      "type": { "OfferCreate": 1 }
    },
    {
      "date": "2020-02-03T00:00:00Z",
      "transaction_count": 1,
      "result": { "tesSUCCESS": 1 },
      "type": { "Payment": 1 }
    }
  ]
}
```

Example: a row for each month, with the value of the account at the end of it. At the end of April the 20 USD it held
are worth 5 XRP at the rate of that day, so the account is worth 84.999976 + 5:

`GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/stats/value?interval=month&start=2020-01-01&end=2020-05-01`

<!-- d2-example GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/stats/value?interval=month&start=2020-01-01&end=2020-05-01 -->

```json
{
  "result": "success",
  "count": 4,
  "rows": [
    { "date": "2020-01-01T00:00:00Z", "account_value": "100", "balance_change_count": 1 },
    { "date": "2020-02-01T00:00:00Z", "account_value": "79.999988", "balance_change_count": 2 },
    { "date": "2020-03-01T00:00:00Z", "account_value": "79.999976", "balance_change_count": 1 },
    { "date": "2020-04-01T00:00:00Z", "account_value": "89.999976", "balance_change_count": 2 }
  ]
}
```

### Account analytics: `GET /v2/accounts/{address}/analytics/…`

Four routes that sum up what an account did over a period, for the account pages of the explorer: the balance of each line over
time, the balance changes by type, the counterparties and the DEX trades. They are **additions** (not in the original; see
[ADR-0010](adr/0010-ripple-v2-wire-compatibility.md#2-endpoints-kept-added-dropped) and
[ADR-0013](adr/0013-account-and-market-aggregates.md)): their object shapes and key orders are ours, pinned by tests. They use the
contract layer of every route (API key, rate limit, `Cache-Control: private, max-age=60`, `format=csv`, errors `{"result":"error",
"message"}`), and their answers are the same whether an account is read from its own rows or, when it is a heavy one, from its daily
rollups.

| Topic | Rule |
| --- | --- |
| Address | Not validated, as on the other account routes: an address that is none (or has nothing in the window) has an empty answer. |
| `start`, `end` | The date formats above. The defaults are `2013-01-01` and now. The window is the **UTC days** from the day of `start` to the day of `end`, both whole, whatever the time of day (`end` is included, as in `reports`, unlike the exclusive `end` of `stats/{family}`). With an `interval` it is widened to whole buckets. An `end` on a day before the day of `start` is an empty answer. The answer's `start` is the start of the first day or bucket and its `end` the start of the day or bucket after the last one (so exclusive): `end=2020-06-30` is answered `2020-07-01T00:00:00Z`. |
| `interval` | `day`, `week` (Monday to Monday) or `month` (calendar), all UTC, where a route takes one; anything else answers 400 `invalid interval - use: day, week, month`. A route that has none ignores the parameter, even a wrong one. |
| Bucket limit | At most **1000** buckets, else 400 `choose a date range of at most 1000 buckets`. Only the routes with an `interval` have it. Note the defaults: `analytics/balances` has `interval=day`, and a call with no `start` is a window from 2013-01-01, which is far more than 1000 days: send a `start` (the explorer sends one that fits its period). |
| Error order | `invalid start date format`, `invalid end date format`, then `invalid interval - use: day, week, month`, then the route's other parameter errors in the order of its table, then the bucket limit. |
| Units | Amounts are whole units as exact decimal strings; values are in the native currency, as exact decimal strings; counts are numbers; times are `YYYY-MM-DDTHH:mm:ssZ`; the `date` of a bucket is its start. A key without a value is left out; `null` is never served. |
| Sorting | As each route says, with a last tie-break on the key text, so an answer is deterministic. The lists are whole answers or top lists: there is no `marker`. |
| `format=csv` | The list of the route (`rows`, `counterparties`, `pairs`) as a CSV file, flattened like every other CSV; the file names are given per route. |

**Values.** The value of an amount follows the rule of `reports` and `stats/value`: the native currency is worth itself, an issued
amount is worth the amount over the rate of its asset on its UTC day (units of the asset per native coin, as
[`/v2/exchange_rates`](#get-v2exchange_ratesbasecounter) gives it in strict mode), the quotient cut to 17 significant digits for
each group and day; an asset without a rate that day, or with a rate of 0, is worth 0 (so are LP tokens and any other asset with no
DEX rate); sums of values are exact. For a balance change the asset is `(currency, counterparty)`, or `(currency, the account
itself)` where the change's balance is below 0: the account owes on that line, so what it moves is its own IOU. The rates of closed
days are precomputed once a day for every asset (`native_rates_daily`); today, and yesterday until the ingest has passed it, are
worked out on read and kept for 60 seconds, so a value of those days may be a minute old. Where a closed day has no stored rate yet
(a deployment still back-filling them) it is worked out on read too: the answer is the same, only slower.

#### `GET /v2/accounts/{address}/analytics/balances`

The balance of each trust line (and the native balance) of the account at the end of each bucket of the window.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | | The window (above). |
| `interval` | `day` | `day`, `week` or `month`; the answer always carries it. |
| `currency` | all | Only the lines of this currency (upper-cased). |
| `counterparty` (alias `issuer`) | all | Only the lines with this account. Not together with the native currency: 400 `counterparty cannot be specified for XRP` (`XAH` on Xahau), the message of `balance_changes`. |
| `limit` | 10 (max 50) | How many lines. |
| `format` | json | `csv`: file `<address> - balance history.csv`, the `rows`. |

A bare call, with no `start` (the default is 2013-01-01) and the default `interval=day`, is 400 `choose a date range of at most 1000 buckets`: send a `start`.

A **line** is a currency and its counterparty (none for the native currency), as in `balance_changes`. The balance of a line at the end
of a bucket is its last balance up to then; a bucket without a change carries the balance before it. A balance below 0 is what the
account owes on that line, and is served negative. A line has rows from the bucket of its first change, or from the first bucket of
the window when it changed before it, and a line whose balance went back to 0 keeps its rows of `"0"`. A bucket that has not begun
has no row, so the rows stop at the bucket that holds now, whatever the `end`.

`lines` are the lines that changed up to the end of the window (after the filters), ranked: the native line first; then the lines
that have a rate, by their balance over that rate (the rate of the asset `(currency, counterparty)` on the newest valid day of
`native_rates_daily` at or before the end of the window), largest first; then the lines without one by the size of the balance,
largest first; ties by currency and counterparty. The first `limit` are served, and `lines_total` counts all of them. While the
stored rates are not there yet (a deployment back-filling them) no line has a rate and the lines after the native one rank by the
size of their balance. The `balance` of a line in `lines` is its balance at the end of the window.

`GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/analytics/balances?interval=month&start=2020-03-01&end=2020-05-31&limit=3`

<!-- d2-example GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/analytics/balances?interval=month&start=2020-03-01&end=2020-05-31&limit=3 -->

```json
{
  "result": "success",
  "start": "2020-03-01T00:00:00Z",
  "end": "2020-06-01T00:00:00Z",
  "interval": "month",
  "lines_total": 3,
  "lines": [
    { "currency": "XRP", "balance": "84.999976" },
    { "currency": "USD", "counterparty": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B", "balance": "20" },
    { "currency": "CAD", "counterparty": "rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7", "balance": "-5" }
  ],
  "count": 7,
  "rows": [
    { "date": "2020-03-01T00:00:00Z", "currency": "XRP", "balance": "79.999976" },
    { "date": "2020-03-01T00:00:00Z", "currency": "USD", "counterparty": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B", "balance": "40" },
    { "date": "2020-04-01T00:00:00Z", "currency": "XRP", "balance": "84.999976" },
    { "date": "2020-04-01T00:00:00Z", "currency": "USD", "counterparty": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B", "balance": "20" },
    { "date": "2020-05-01T00:00:00Z", "currency": "XRP", "balance": "84.999976" },
    { "date": "2020-05-01T00:00:00Z", "currency": "USD", "counterparty": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B", "balance": "20" },
    { "date": "2020-05-01T00:00:00Z", "currency": "CAD", "counterparty": "rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7", "balance": "-5" }
  ]
}
```

Keys: answer `result, start, end, interval, lines_total, lines, count, rows`; line `currency, counterparty?, balance`; row `date,
currency, counterparty?, balance`. `count` is the number of rows. The rows are ordered by `date`, then by the order of `lines`. In
the example the XRP and USD lines began before the window, so they have a row from its first bucket on; the CAD line, which the
account owes, starts inside it, in May, with a negative balance.

Errors, in order: 400 `invalid start date format`, `invalid end date format`, `invalid interval - use: day, week, month`, `counterparty
cannot be specified for XRP` (`XAH`), `choose a date range of at most 1000 buckets`; 500 `unable to retrieve balance history`.

#### `GET /v2/accounts/{address}/analytics/balance_changes`

The sums of the balance changes of the account in the window, by change type, with what they were worth.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | | The window (above). |
| `interval` | none | Without it the `rows` are per change type and asset; with `day`, `week` or `month` they are per bucket and change type. |
| `format` | json | `csv`: file `<address> - balance change totals.csv`, the `rows`. |

Every balance change of the window counts once, the fee rows (`transaction_cost`) included. A **change type** is one of the ten of
`balance_changes`; the changes of transaction types the original never classified have none, and are grouped without a `change_type`
key (as the objects of `balance_changes` leave it out). `in` is the sum of the positive changes, `out` the sum of the negative ones
as a positive amount, `in_value` and `out_value` their values in the native currency (see Values above), `net_value` is `in_value -
out_value`, `count` the number of changes. An asset has no `issuer` key for the native currency; on a line the account owes on, the
`issuer` is the account itself.

Change types come in this order: `transaction_cost`, `payment_destination`, `payment_source`, `exchange`, `intermediary`,
`escrow_create`, `escrow_finish`, `escrow_cancel`, `paychannel_fund`, `paychannel_payout`, then the changes without one. `totals` has an
entry for each type that has a change, in that order. `rows` without an `interval` are ordered by type, then by `in_value + out_value`,
largest first, then by currency and issuer; with an `interval`, by date, then type, and only for the buckets and types that have a
change.

`GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/analytics/balance_changes?start=2020-02-01&end=2020-03-31`

<!-- d2-example GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/analytics/balance_changes?start=2020-02-01&end=2020-03-31 -->

```json
{
  "result": "success",
  "start": "2020-02-01T00:00:00Z",
  "end": "2020-04-01T00:00:00Z",
  "totals": [
    { "change_type": "transaction_cost", "count": 2, "in_value": "0", "out_value": "0.000024", "net_value": "-0.000024" },
    { "change_type": "payment_destination", "count": 2, "in_value": "5", "out_value": "0", "net_value": "5" },
    { "change_type": "payment_source", "count": 1, "in_value": "0", "out_value": "20", "net_value": "-20" }
  ],
  "count": 3,
  "rows": [
    {
      "change_type": "transaction_cost",
      "currency": "XRP",
      "count": 2,
      "in": "0",
      "out": "0.000024",
      "in_value": "0",
      "out_value": "0.000024"
    },
    {
      "change_type": "payment_destination",
      "currency": "USD",
      "issuer": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
      "count": 2,
      "in": "40",
      "out": "0",
      "in_value": "5",
      "out_value": "0"
    },
    {
      "change_type": "payment_source",
      "currency": "XRP",
      "count": 1,
      "in": "0",
      "out": "20",
      "in_value": "0",
      "out_value": "20"
    }
  ]
}
```

With an `interval` a row is `{ "date", "change_type"?, "count", "in_value", "out_value" }` (no asset: the values already added the
assets up) and the answer carries `interval` after `end`. This is the account `rBtgXX…` of the test world, whose two changes of 2 XRP
in April belong to a transaction type with no change type:

`GET /v2/accounts/rBtgXXrLQntDfCoJFhdnmhPqMuK2DuwepA/analytics/balance_changes?interval=month&start=2020-02-01&end=2020-04-30`

<!-- d2-example GET /v2/accounts/rBtgXXrLQntDfCoJFhdnmhPqMuK2DuwepA/analytics/balance_changes?interval=month&start=2020-02-01&end=2020-04-30 -->

```json
{
  "result": "success",
  "start": "2020-02-01T00:00:00Z",
  "end": "2020-05-01T00:00:00Z",
  "interval": "month",
  "totals": [
    { "change_type": "transaction_cost", "count": 1, "in_value": "0", "out_value": "0.000012", "net_value": "-0.000012" },
    { "change_type": "payment_destination", "count": 7, "in_value": "560", "out_value": "0", "net_value": "560" },
    { "change_type": "payment_source", "count": 2, "in_value": "0", "out_value": "100", "net_value": "-100" },
    { "count": 2, "in_value": "2", "out_value": "2", "net_value": "0" }
  ],
  "count": 6,
  "rows": [
    { "date": "2020-02-01T00:00:00Z", "change_type": "transaction_cost", "count": 1, "in_value": "0", "out_value": "0.000012" },
    { "date": "2020-02-01T00:00:00Z", "change_type": "payment_destination", "count": 4, "in_value": "550", "out_value": "0" },
    { "date": "2020-02-01T00:00:00Z", "change_type": "payment_source", "count": 1, "in_value": "0", "out_value": "100" },
    { "date": "2020-03-01T00:00:00Z", "change_type": "payment_destination", "count": 3, "in_value": "10", "out_value": "0" },
    { "date": "2020-04-01T00:00:00Z", "change_type": "payment_source", "count": 1, "in_value": "0", "out_value": "0" },
    { "date": "2020-04-01T00:00:00Z", "count": 2, "in_value": "2", "out_value": "2" }
  ]
}
```

Keys: answer `result, start, end, interval?, totals, count, rows`; total `change_type?, count, in_value, out_value, net_value`; row
without an interval `change_type?, currency, issuer?, count, in, out, in_value, out_value`; row with an interval `date,
change_type?, count, in_value, out_value`. `count` is the number of rows.

Errors, in order: 400 `invalid start date format`, `invalid end date format`, `invalid interval - use: day, week, month`, `choose a
date range of at most 1000 buckets`; 500 `unable to retrieve balance changes`.

#### `GET /v2/accounts/{address}/analytics/counterparties`

The accounts the account paid and was paid by in the window, with what the payments were worth.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | | The window (above). The route has no `interval`. |
| `sort` | `value` | `value` (by `total_value`) or `count` (by `payments_sent + payments_received`), largest first, then by account. Anything else: 400 `invalid sort - use: value, count`. |
| `limit` | 20 (max 1000) | |
| `format` | json | `csv`: file `<address> - counterparties.csv`. |

The payments of the account in the window (the rows of `account_payments`), each once, grouped by the account on the other side, with the
side rule of `reports` (a payment of the account to itself would be a payment sent, its counterparty being the account; the ingest
stores none). `sent_value` is what the account paid the counterparty and `received_value` what the counterparty paid the account (the
delivered amounts, valued as above); `payments_sent` and `payments_received` count the payments each way; `first` and `last` are the
times of the first and the last payment between the two in the window. `total` is the number of different counterparties in the window
and `count` the number served: the first `limit` by `sort`. The order is exact (the values are exact decimals), whatever the database
ranked first.

`GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/analytics/counterparties?limit=6&start=2020-01-01&end=2020-06-30`

<!-- d2-example GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/analytics/counterparties?limit=6&start=2020-01-01&end=2020-06-30 -->

```json
{
  "result": "success",
  "start": "2020-01-01T00:00:00Z",
  "end": "2020-07-01T00:00:00Z",
  "sort": "value",
  "total": 3,
  "count": 3,
  "counterparties": [
    {
      "account": "rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7",
      "sent_value": "15",
      "received_value": "24",
      "total_value": "39",
      "payments_sent": 2,
      "payments_received": 3,
      "first": "2020-01-16T09:00:00Z",
      "last": "2020-06-15T09:00:00Z"
    },
    {
      "account": "rrrrUBy92h6worVCYERZcVCzgzgmHb17Dx",
      "sent_value": "20",
      "received_value": "0",
      "total_value": "20",
      "payments_sent": 4,
      "payments_received": 1,
      "first": "2020-01-17T09:00:00Z",
      "last": "2020-04-20T12:00:00Z"
    },
    {
      "account": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
      "sent_value": "0",
      "received_value": "7",
      "total_value": "7",
      "payments_sent": 0,
      "payments_received": 1,
      "first": "2020-01-17T09:00:00Z",
      "last": "2020-01-17T09:00:00Z"
    }
  ]
}
```

Keys: `result, start, end, sort, total, count, counterparties`; counterparty `account, sent_value, received_value, total_value,
payments_sent, payments_received, first, last`.

Errors, in order: 400 `invalid start date format`, `invalid end date format`, `invalid sort - use: value, count`; 500 `unable to retrieve
counterparties`.

Counterparties are always read from the payments themselves, for every account (a payment table grouped by counterparty compresses
badly, so nothing is rolled up): well under 500 ms for an ordinary account, 2 to 10 seconds for a year or more of an exchange's
hundreds of thousands of payments (the explorer gives this one call a 15 second timeout). An account with very many paid assets over
many days, **while the stored rates are still being back-filled**, can overrun what one query may carry (the rates of the days
that are not stored travel in the request to the database) and answer the 500 above; once the back-fill is done
(`syncer_rates_daily_missing_days` is 0) only the rates of today and yesterday travel, and it does not happen in practice (see
[operations](operations.md#account-and-market-aggregates)).

#### `GET /v2/accounts/{address}/analytics/exchanges`

What the account traded on the exchange in the window, per pair.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | | The window (above). The route has no `interval`. |
| `limit` | 20 (max 1000) | |
| `format` | json | `csv`: file `<address> - exchange pairs.csv`. |

The trades of the account in the window (it is the buyer or the seller; the rows of `account_exchanges`), each once, per pair **in the
canonical stored order** (as `/v2/exchanges` serves a pair). `bought` is the base the account received (it was the buyer) and `sold` the
base it gave (it was the seller); a trade of the account with itself is in both. `bought_counter` is the counter the account paid for
what it `bought`, and `sold_counter` the counter it received for what it `sold`: a client that shows a pair the other way round (the
explorer's natural orientation) has both sides of each direction exactly, and only has to swap them. `native_volume` is, for a pair
with a native side, the volume of that side; for another pair, for each day the base volume over the rate of the base (or, where the
base has none, the counter volume over the rate of the counter), cut to 17 significant digits and added up; it is left out when no day
of the pair had a rate. The pairs are sorted by `native_volume`, largest first, the pairs without one last by `count`, then by the pair;
`total` is the number of pairs in the window and `count` the number served: the first `limit`. Swaps against AMM pools, where the data
holds them, are trades like any other: no filter, and no AMM key.

`GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/analytics/exchanges?start=2020-01-01&end=2020-06-30`

<!-- d2-example GET /v2/accounts/rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD/analytics/exchanges?start=2020-01-01&end=2020-06-30 -->

```json
{
  "result": "success",
  "start": "2020-01-01T00:00:00Z",
  "end": "2020-07-01T00:00:00Z",
  "total": 3,
  "count": 3,
  "pairs": [
    {
      "base_currency": "EUR",
      "base_issuer": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
      "counter_currency": "USD",
      "counter_issuer": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
      "count": 4,
      "base_volume": "139",
      "counter_volume": "85",
      "bought": "130",
      "sold": "9",
      "bought_counter": "67",
      "sold_counter": "18",
      "native_volume": "37"
    },
    {
      "base_currency": "USD",
      "base_issuer": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
      "counter_currency": "XRP",
      "count": 4,
      "base_volume": "35.5",
      "counter_volume": "13.25",
      "bought": "15.5",
      "sold": "21",
      "bought_counter": "8.25",
      "sold_counter": "5.25",
      "native_volume": "13.25"
    },
    {
      "base_currency": "XRP",
      "counter_currency": "ZAR",
      "counter_issuer": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
      "count": 1,
      "base_volume": "5",
      "counter_volume": "100",
      "bought": "5",
      "sold": "0",
      "bought_counter": "100",
      "sold_counter": "0",
      "native_volume": "5"
    }
  ]
}
```

Keys: `result, start, end, total, count, pairs`; pair `base_currency, base_issuer?, counter_currency, counter_issuer?, count,
base_volume, counter_volume, bought, sold, bought_counter, sold_counter, native_volume?`. In the example the EUR/USD pair has no
native side: its volume is worked out through the rate of USD on each day (the USD that was paid on a day without a rate is worth
nothing, so 100 EUR for 7 USD adds none), and the XRP/ZAR pair has a native base.

Errors, in order: 400 `invalid start date format`, `invalid end date format`; 500 `unable to retrieve exchanges`.

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

`fees` and `fee_stats` answer `{ "result": "success", "marker": "…", "count": n, "rows": [...] }` (the key order is `result, marker, count, rows`); the three volume routes answer `{ "result": "success", "count": n, "marker": "…", "rows": [...] }`. `marker` is present only when there is a next page. `markets` has an object of its own, described with the route.

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

Row keys: `components, count, exchange, total, exchange_rate, start_time, end_time` (and `fees_est?` last, on the live day row of `amm_volume`: see below). A **trade** component is `{count, rate, amount,
base, counter, converted_amount}`, a **payment** component `{currency, issuer?, amount, count, rate, converted_amount}`
(`issuer` absent for the native currency), an **AMM** component `{amm_account, base, counter, count, amount, rate, converted_amount, fees_est?}`. `amount` is the exact sum in the component's currency, `converted_amount` and
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

**`fees_est`** is on the **live day row of `amm_volume`** (`live=day`, the default: the rolling 24 hours, neither `start` nor `end`) and nowhere
else: not on the other live periods (`hour`, `3day`, `7day`, `30day`), not on the historical rows and not on the trade and payment volumes. A
pool's fees per day are `fees_base_est` and `fees_counter_est` of [its daily history](#get-v2ammpoolspoolhistory). Each component has the
estimated trading fees its pool charged on the swaps of the 24 hours, and the row the sum over its listed components, converted as
`converted_amount` and `total` are (into the native currency, or with `exchange_currency` into the display currency). It is formatted as
`converted_amount` is, a number as text, and it is an **estimate**: each swap's input times the fee in force for it (the pool's trading fee, or
the discounted fee of the auction slot for its holder and the accounts it authorises while the slot is in force; the fee state is carried in
from before the window), as the pool days are computed. It counts **every swap** of the window: the rule that leaves the swaps with a native
leg of 0.0005 or less out of `amount` and `count` does not apply to the fees. The fees of the pool's two sides are put into the unit of `amount`
at the pool's own average price in the window, and converted with the component. A component has no `fees_est` when a side's fee is **not
known** (a swap of the window whose fee was never shown, as for a pool first seen in the middle of its life; part of the fees is never shown as
all of them), and the row has `fees_est` only when it lists at least one component and every listed component has one; `"0"` is a known fee of 0.
In the CSV the columns are there when the answer has them: `components[i].fees_est` right after `components[i].converted_amount`, and `fees_est`
after `end_time`.

```json
{ "result": "success", "count": 1,
  "rows": [{
    "components": [{ "amm_account": "r…", "base": { "currency": "USD", "issuer": "r…" }, "counter": { "currency": "XRP" },
                     "count": 120, "amount": "5000", "rate": "0.11000000", "converted_amount": "45454.545", "fees_est": "22.727" }],
    "count": 120, "exchange": { "currency": "XRP" }, "total": "45454.545", "exchange_rate": "1.0000000",
    "start_time": "2026-10-15T12:00:00Z", "end_time": "2026-10-16T12:00:00Z", "fees_est": "22.727" }] }
```

Errors: 400 as above, `invalid start date format`, `invalid end date format`, `invalid marker`; 500 `error getting data`
(also for all three routes).

**Differences from data.ripple.com**: the `amm_volume` route does not exist in the original (an extra); `exchange_volume` includes the swaps against AMM pools in the trades of the configured markets; the `minute` live period of the original's develop branch is **not** supported; component
`rate` follows the semantics above (the original's non-native trade component carried the pair's vwap, so `amount / rate` did
not reproduce `converted_amount`); `converted_amount` is always a string; historical rows carry `end_time` (the start of the
next bucket, exclusive); the historical display currency uses each bucket's own native-to-display price. A day counts as final
only once the ingest has passed it by an hour, so volumes follow the ingest rather than the wall clock.

### `GET /v2/network/markets`

The trade statistics of **every pair** that traded in a live period, in one call: the table of the explorer's Markets page. It is an
**addition** (not in the original; see [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md#2-endpoints-kept-added-dropped) and
[ADR-0013](adr/0013-account-and-market-aggregates.md)): its object and key order are ours, and it uses the contract layer of every
route (API key, rate limit, `Cache-Control: private, max-age=60`, `format=csv`, errors `{"result":"error","message"}`). The answer is
one precomputed set, read in a few milliseconds.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `period` | `day` | `day`, `7day` or `30day`, the live periods of `exchange_volume` that the explorer uses. Anything else: 400 `invalid period - use: day, 7day, 30day`. An empty `period` is the default. |
| `min_trades` | 10 | List the pairs with at least this many trades: a whole number (plain digits) from 1 to 1,000,000, else 400 `invalid min_trades`. An empty one is the default. |
| `exchange_currency`, `exchange_issuer` | the native currency | Also show the volumes in this currency, at the live rate, as the live volume rows do. The errors of the volume routes: 400 `exchange currency must have an issuer`, `XRP cannot have an issuer` (`XAH` on Xahau), `invalid exchange issuer address`. The native currency (with no issuer) adds nothing. |
| `amm` | `include` | Which trades the answer counts: `include` (all of them), `exclude` (the order-book trades only) or `only` (the swaps against AMM pools). Case-sensitive; an empty `amm` is the default; anything else: 400 `invalid amm filter - use: include, exclude, only`. The answer echoes it. |
| `limit` | 1000 (max 5000) | How many markets. |
| `format` | json | `csv`: file `markets.csv`, the `markets` (flattened: the sparkline is the columns `sparkline[0].date`, `sparkline[0].close`, ...; `amm_share` and `amm_pool` are columns where the markets have them, `amm_pool` as `true` or `false`). |

- **Pairs.** Every pair traded in the window, not the markets config, in the canonical stored order of its currencies (as
  `/v2/exchanges` serves a pair); a price is **counter per base**. A trade counts when its native leg is above 0.0005 (the rule of the
  candles and of `reduce`: dust is left out), and `count` counts those. The pairs with at least `min_trades` trades are listed, sorted by
  `native_volume`, largest first (compared as numbers), the pairs without one last by `count`, then by the pair; at most `limit` are
  served. A swap against an AMM pool is a trade of its pair like an order-book trade (the `amm` parameter below picks which of them are counted).
- **Window.** The periods start on the hour: a set is made of whole hours of trade statistics, so the 24 hours of `day` are 24 to 25
  hours (`start_time` is the hour that is 24 hours before the hour of `end_time`, and `end_time` is the close time of the newest
  ledger the set covers), and `7day` and `30day` the same on 7 and 30 days. The `day` set is rewritten every minute, `7day` and
  `30day` every five minutes; `end_time` says how current a set is. A set is written only when every hour of its window (and of the
  7 days of its sparkline) has its statistics; otherwise the previous set stays and its `end_time` ages.
- **Prices.** `open`, `high`, `low` and `last` have 8 significant digits (as candles): `open` and `last` are the rates of the first and
  last trade of the window (by ledger, transaction and node), `high` and `low` the largest and smallest rate. `open_time` and
  `last_time` are the close times of those two trades. `change` is `(last / open - 1) * 100` in percent, exact, rounded half up (away
  from zero) to 2 decimals; it is left out where `open` is not above 0, which no trade is.
- **Volumes** are exact sums in whole units: `base_volume` of the base, `counter_volume` of the counter. `native_volume` is the volume in
  the native currency: for a pair with a native side, that side's volume; for another pair the base volume over the rate of the base,
  or, where the base has none, the counter volume over the rate of the counter (cut to 17 significant digits); a pair without a rate
  on either side has none, and the key is left out. The rate of an asset is its volume over the native volume of its pair against the
  native currency in the same window (all trades, whether or not that pair is listed), so every asset that trades against the native
  currency has one.
- **`sparkline`** is the close of each of the last 7 UTC days, ending with the day of `end_time` (6 closed days and today so far), as
  `{ "date", "close"? }`: a day without a trade carries the close before it, and `close` is left out for a day with none before it
  within the 7 days.
- **Totals.** `pairs` is the number of listed pairs (with `count >= min_trades`), whatever the `limit`; `pairs_traded`, `count` and
  `native_volume` are over every pair that traded in the window (the pairs without a native volume add none), counting the trades the `amm`
  filter keeps.
- **Display currency.** With `exchange_currency` the answer adds `exchange` (`{currency, issuer?}`) and `exchange_rate` (units of it per
  native coin at the live rate, 8 significant digits) after `end_time`, and a `converted_volume` after `native_volume` in the totals
  and in each market that has one: the native volume times the unrounded rate, cut to 17 significant digits.
- **The `amm` filter.** `include` counts every trade of the window, `exclude` the order-book trades only (what this route counted before the
  AMM data), `only` the swaps against pools. A filter changes what is counted, not how: the pairs, `count` (and so which pairs reach
  `min_trades`: a pair with 6 order-book trades and 4 swaps has 10 trades under `include`, 6 under `exclude` and 4 under `only`), the volumes,
  `native_volume`, `open`, `high`, `low`, `last` and their times, the `sparkline` and the totals `pairs_traded`, `count` and `native_volume` are
  those of the trades the filter keeps; a pair with none of them is not in the answer. The rate of an asset, which `native_volume` goes through
  for a pair without a native side, is the one of all the trades of the window whatever the filter. `amm` is in every answer, right after
  `period`: the filter the answer is for, `"include"` when the request has none (as `period` is echoed when it was defaulted), also in the answer
  of no set.
- **The AMM fields.** `amm_share` of a market is the part of the pair's **base volume** that was swaps, over the base volume of all the trades
  of the pair in the window: text with exactly 4 decimals, rounded half up (`"0.3400"`, `"1.0000"`, `"0.0000"` for a pair without swaps). It
  describes the pair, so it is the same whichever `amm` filter the answer is for, and it is a share of the base **as stored** (the canonical
  order of the pair): it does not change when a consumer shows the pair inverted. `amm_pool` is `true` when the pair has an AMM pool that is not
  deleted, else `false`. `totals.amm_share` is the part of the native volume that was swaps, over every pair that traded with a native volume,
  whatever `min_trades`, `limit` and `amm` (the sum of each pair's `native_volume` times its `amm_share`, exact, over the sum of the
  `native_volume`s, rounded once to 4 decimals), `"0.0000"` when no pair has a native volume; it is last in the totals. On a market the two come after `last_time`.
- **Present only when known.** A set has these fields only when every ledger that closed in its window (from `start_time` to `end_time`) was
  written by a parser that knows AMM data (parser version 2): the ledgers ingested since the AMM release or ingested again with `range-ingest
  --reprocess`. A window without a ledger counts as known. Otherwise `amm_share`, `amm_pool` and `totals.amm_share` are **left out**: an absent
  field means "not known", never `0` or `false`, and the answer is otherwise as usual (on a database whose history was not ingested again, the
  `day` set has them a day after the AMM release and the `30day` set 30 days after it). While the AMM data of a window is incomplete, `exclude` is exact (a swap that
  was not parsed is no exchange at all) and `only` is partial. Xahau has no AMM: its sets have `"0.0000"` and `false` once its ledgers are of parser 2.
- **No set yet** (a database whose aggregator has not written one): `{ "result": "success", "period": "day", "amm": "include", "count": 0, "markets": [] }`. The
  three filters of a period are separate sets, written one after the other (`exclude`, `only`, then `include`) by each run of the aggregator, so a
  filter that no run has written yet is this answer too.

`GET /v2/network/markets?period=day&limit=1`

<!-- d2-example GET /v2/network/markets?period=day&limit=1 -->

```json
{
  "result": "success",
  "period": "day",
  "amm": "include",
  "start_time": "2020-07-01T10:00:00Z",
  "end_time": "2020-07-02T10:42:17Z",
  "totals": { "pairs": 9, "pairs_traded": 11, "count": 112, "native_volume": "243.5", "amm_share": "0.0000" },
  "count": 1,
  "markets": [
    {
      "base_currency": "USD",
      "base_issuer": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
      "counter_currency": "XRP",
      "count": 13,
      "base_volume": "130",
      "counter_volume": "65",
      "native_volume": "65",
      "open": "0.50000000",
      "high": "0.80000000",
      "low": "0.30000000",
      "last": "0.40000000",
      "change": "-20.00",
      "open_time": "2020-07-01T12:00:00Z",
      "last_time": "2020-07-02T10:42:17Z",
      "amm_share": "0.0000",
      "amm_pool": false,
      "sparkline": [
        { "date": "2020-06-26T00:00:00Z" },
        { "date": "2020-06-27T00:00:00Z" },
        { "date": "2020-06-28T00:00:00Z", "close": "0.52500000" },
        { "date": "2020-06-29T00:00:00Z", "close": "0.52500000" },
        { "date": "2020-06-30T00:00:00Z", "close": "0.52500000" },
        { "date": "2020-07-01T00:00:00Z", "close": "0.50000000" },
        { "date": "2020-07-02T00:00:00Z", "close": "0.40000000" }
      ]
    }
  ]
}
```

With a display currency:

`GET /v2/network/markets?period=day&limit=1&exchange_currency=USD&exchange_issuer=rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`

<!-- d2-example GET /v2/network/markets?period=day&limit=1&exchange_currency=USD&exchange_issuer=rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B -->

```json
{
  "result": "success",
  "period": "day",
  "amm": "include",
  "start_time": "2020-07-01T10:00:00Z",
  "end_time": "2020-07-02T10:42:17Z",
  "exchange": { "currency": "USD", "issuer": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B" },
  "exchange_rate": "2.0000000",
  "totals": {
    "pairs": 9,
    "pairs_traded": 11,
    "count": 112,
    "native_volume": "243.5",
    "converted_volume": "487",
    "amm_share": "0.0000"
  },
  "count": 1,
  "markets": [
    {
      "base_currency": "USD",
      "base_issuer": "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
      "counter_currency": "XRP",
      "count": 13,
      "base_volume": "130",
      "counter_volume": "65",
      "native_volume": "65",
      "converted_volume": "130",
      "open": "0.50000000",
      "high": "0.80000000",
      "low": "0.30000000",
      "last": "0.40000000",
      "change": "-20.00",
      "open_time": "2020-07-01T12:00:00Z",
      "last_time": "2020-07-02T10:42:17Z",
      "amm_share": "0.0000",
      "amm_pool": false,
      "sparkline": [
        { "date": "2020-06-26T00:00:00Z" },
        { "date": "2020-06-27T00:00:00Z" },
        { "date": "2020-06-28T00:00:00Z", "close": "0.52500000" },
        { "date": "2020-06-29T00:00:00Z", "close": "0.52500000" },
        { "date": "2020-06-30T00:00:00Z", "close": "0.52500000" },
        { "date": "2020-07-01T00:00:00Z", "close": "0.50000000" },
        { "date": "2020-07-02T00:00:00Z", "close": "0.40000000" }
      ]
    }
  ]
}
```

Keys: answer `result, period, amm, start_time, end_time, exchange?, exchange_rate?, totals, count, markets` (of no set: `result, period, amm,
count, markets`); totals `pairs, pairs_traded, count, native_volume, converted_volume?, amm_share?`; market `base_currency, base_issuer?,
counter_currency, counter_issuer?, count, base_volume, counter_volume, native_volume?, converted_volume?, open, high, low, last, change?,
open_time, last_time, amm_share?, amm_pool?, sparkline`. `count` is the number of markets served.

Errors, in order: 400 `invalid period - use: day, 7day, 30day`, `invalid min_trades`, `exchange currency must have an issuer`, `XRP cannot
have an issuer` (`XAH`), `invalid exchange issuer address`, `invalid amm filter - use: include, exclude, only`; 500 `unable to retrieve markets`.

**The analytics routes carry no AMM field.** `analytics/exchanges` and the other account routes count the swaps against pools as trades like any
other, without a filter and without an `amm` key (the values follow the rates and the trades, which include the swaps). Which swaps the data holds
depends on the AMM re-ingest ([backfill](backfill.md#amm-data-re-ingest)); the answers say nothing of how complete it is.

**Differences from `exchange_volume`** (which is unchanged: its components stay the markets config, for Ripple compatibility). For a
market that both routes show, the numbers can differ: the markets window starts on the hour, where the live volume window is exact (the
last 24 hours to the second); the markets rate of an asset comes from its native pair whether or not that pair is configured, where
`exchange_volume` takes only the configured native markets; `network/markets` lists every pair that traded, `exchange_volume` the
configured ones; and prices are in the canonical stored orientation of the pair.

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
| `interval` | none | Empty or missing: every state. `day`: the days with activity, and the range of the days that are computed (`computed_start`, `computed_end`). Anything else is 400 `invalid interval`. |
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
{ "result": "success", "computed_start": "2026-09-17", "computed_end": "2026-10-16", "count": 1, "marker": "…",
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
would understate it; the CSV cell is then empty), and is `"0"` when every swap into its side had a known fee of 0 or there was none.
`liquidity_in_*` and `liquidity_out_*` are the
amounts deposited and withdrawn (a creation counts as a deposit, a clawback as a withdrawal). The reserves, `lp_supply`, `trading_fee`
and `value_native` are those at the end of the day (a pool deleted during the day has none, and no value). The marker is the start of
the last day, in unix seconds.

**The days the figures are computed for** (`computed_start`, `computed_end`). With `interval=day` the answer also says which days of the
request's window the daily figures have been computed for, as two dates (`YYYY-MM-DD`, UTC) right after `result`. `computed_end` is the newest
day of the window that has a computed set (today's, which is refreshed, counts; so does a day whose set is not final yet), and
`computed_start` the oldest day from which every day up to `computed_end` has one: a hole ends the range, and the days under it are not in it. A
day inside the range without a row of this pool is a day it was quiet; a day outside the range is **not computed yet** (the daily figures of
all pools are back-filled newest first, so while that runs `computed_start` moves back, to the first day with AMM activity at the end of it).
A day counts as computed only with the current version of the computation; a day made with an older one is to be computed again, and is not
counted. The window is the request's (`start` and `end` as below, the whole history without them), never narrowed by the `marker`, so every
page of an answer has the same two dates. Both are **left out** when no day of the window has a computed set. They are not in the CSV and not in
the list of states (no `interval`). The keys of the answer are `result, computed_start?, computed_end?, count, marker?, days`.

**The window of the days.** A day is a row when its **start** (00:00 UTC) is within `start` and `end`: at or after `start`, and before
the end of the period `end` names. So `start=2026-10-01&end=2026-10-03` gives up to three days, and a `start` with a time of day leaves out
the day it falls in. The days are the ones the aggregator has computed (today is refreshed about every five minutes; see
[syncer](syncer.md#the-amm-jobs)); a day without activity has no row.

**Empty and 404.** A page with no rows is 200 with an empty list when the pool has a state in a committed ledger (a pool with states but
no day yet answers an empty `days`, with the computed range when the window has one), and 404 `pool not found` when it has none.

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

## Validators and amendments

The validators of the network, the trusted UNL and the amendments. `data.ripple.com` served a validator list and per-validator reports from
its own crawler. Its list and its validator (`/v2/network/validators[/{pubkey}]`) are served here from other data and differ from it (see
**Differences from data.ripple.com** under each route); its manifests, reports, validator reports and rippled versions are out of scope
[above](#compatibility); the summary, the validations of a validator and the amendments are new. The data come from the validations the
syncer collects, the validator lists the syncer fetches from the publishers, the ledger state it polls from the node and what it computes from
them, not from a crawler.

**Formats.** A key without a value is absent, never `null`. Instants of receipt (`fetched`, `first_seen`, `last_seen`, `last_error_at`, and
`updated` of the summary) are `YYYY-MM-DDTHH:mm:ss.SSSZ`; ledger and wall times (`close_time`, `expiration`, `agreement_through`, `expected`) are
`YYYY-MM-DDTHH:mm:ssZ`; days are `YYYY-MM-DD`. Native amounts are whole units as exact decimal text (`"0.00001"`, `"1"`, `"0.2"`). Counts are
numbers; a percentage is a number to 2 decimals; an agreement `score` is text to 4 decimals, rounded half up. The key order of every object is the
one written here and is pinned by tests.

**Cache-Control** (only while `GH_CACHE_CONTROL` is not empty; an error is always `no-store`):

| Route | `Cache-Control` |
| --- | --- |
| `/v2/network/validators`, `/v2/network/validators/summary`, `/v2/network/validators/{key}` | `private, max-age=30` |
| `/v2/network/validators/{key}/validations` | `private, max-age=5`; with a `marker`: `private, max-age=300` |
| `/v2/network/amendments`, `/v2/network/amendments/{name}` | `private, max-age=60` |

**Where the data come from.** The API reads only tables of the database; it never asks a node.

- The syncer's `validations` collector writes the validations, the manifests (the signing key of every validator, its domain) and when each validator
  was first and last seen.
- The syncer's `validators` worker fetches the validator lists of the publishers (`GH_UNL_PUBLISHERS`), checks the domains of the validators,
  polls the ledger state of the node (the enabled amendments and their majorities, the negative UNL, the fees) every minute, and computes the voting
  rounds (what each validator voted at each voting ledger, 256 ledgers apart) and the agreement of each validator per UTC hour.
- A **validator directory** is built from those tables, one build at a time per replica, and kept for up to 10 seconds (counted from the start of the
  build): a request costs at most one build in 10 s, whatever the number of requests. Every read that adds up rows by validator first maps a signing key to its master key through the
  manifests (a map each statement computes inside itself, so its size does not matter), so a validation recorded before its manifest was known counts for the right validator; a round and an hour are read whole, in the
  newest version written (a rewritten round or hour is never mixed with its older version).
- "In use now" (the trusted UNL, which publishers name a validator) uses the lists a publisher served under the key it is configured with; a
  list of a key it no longer uses was trusted in its time and is history.
- The **amendments** are assembled on top of the directory, from the newest ledger state, what the node says of each amendment ID, the metadata file
  of the network (`GH_AMENDMENTS_CONFIG`: names, the version that introduced an amendment, its standard, a description; an invalid file fails the
  boot), the votes of the last 30 days and the `EnableAmendment` transactions the index holds. The assembly is kept for up to 10 seconds on top of a
  directory that is itself up to 10 seconds old, so an answer can be up to about 20 seconds old. The newest round, its votes and its tallies are
  always of one version (the one the directory read), and an amendment ID is matched whatever its case in the tables.

The routes of the original `/v2/network/validators/{pubkey}/manifests`, `/v2/network/validators/{pubkey}/reports`,
`/v2/network/validator_reports` and `/v2/network/rippled_versions` are not served and answer 404 `{"result":"error","message":"Cannot GET ..."}`.

### `GET /v2/network/validators/summary`

The network overview of the Validators board: how many validators there are, the trusted UNL and its publishers, the quorum, the negative UNL, the
fees, the next flag ledger, the software versions, and how far agreement and votes are computed. No parameters (any that are sent are ignored).

```json
{
  "result": "success",
  "ledger_index": 107748183,
  "close_time": "2026-10-19T15:54:12Z",
  "validators": {"seen_24h": 54, "unl_seen_24h": 34, "others_seen_24h": 20, "all": 55},
  "unl": {
    "trusted": 35,
    "threshold": 1,
    "publishers": [
      { "id": "unl.xrplf.org", "url": "https://unl.xrplf.org", "public_key": "ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1", "status": "expired", "sequence": 2026070302,
        "version": 1, "expiration": "2026-10-18T15:54:20Z", "fetched": "2026-10-12T15:54:20.380Z", "validators": 34,
        "seen_24h": 33, "last_error": "http_status", "last_error_at": "2026-10-19T15:44:19.620Z" },
      { "id": "vl.ripple.com", "url": "https://vl.ripple.com", "public_key": "ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734", "status": "ok", "sequence": 85,
        "version": 1, "expiration": "2027-04-07T15:54:20Z", "fetched": "2026-10-19T15:51:26.114Z", "validators": 35,
        "seen_24h": 34 }
    ]
  },
  "quorum": {"value": 28, "unl_size": 35, "negative_unl": 1, "node": 28},
  "negative_unl": [ {"validation_public_key": "nHUH2dDP9pG4fbUza2gV5Uzq1cprSQvuNLQbRagPW6uVnUA4qwdP", "first_ledger": 107747000} ],
  "negative_unl_pending": {"to_reenable": "nHUH2dDP9pG4fbUza2gV5Uzq1cprSQvuNLQbRagPW6uVnUA4qwdP"},
  "fees": {"base_fee": "0.00001", "reserve_base": "1", "reserve_inc": "0.2"},
  "next_flag_ledger": {"ledger_index": 107748352, "voting_ledger": 107748351, "expected": "2026-10-19T16:05:28Z"},
  "latest_version": "3.4.1",
  "versions": [ {"version": "3.5.0-rc1", "unl": 0, "all": 3}, {"version": "3.4.1", "unl": 30, "all": 40}, {"version": "3.4.0", "unl": 4, "all": 9} ],
  "versions_unknown": {"unl": 1, "all": 2},
  "agreement_through": "2026-10-19T15:00:00Z",
  "votes_through_ledger": 107748095,
  "updated": "2026-10-19T15:54:20.222Z"
}
```

Keys of the summary, in order: `result, ledger_index, close_time, validators, unl, quorum, negative_unl, negative_unl_pending, fees, next_flag_ledger, latest_version, versions, versions_unknown, agreement_through, votes_through_ledger, updated`.

Keys of a publisher, in order: `id, url, public_key, status, sequence, version, expiration, fetched, validators, seen_24h, last_error, last_error_at`.

| Key | Meaning |
| --- | --- |
| `ledger_index`, `close_time` | The newest committed ledger of the index. Without one, the ledger of the newest ledger state and no `close_time`; without either, both are absent. |
| `validators` | `seen_24h`: validators seen in the last 24 hours (a signing key counts for its master); `unl_seen_24h`: of those on the trusted UNL; `others_seen_24h`: the rest; `all`: the trusted UNL together with those seen in 24 hours. |
| `unl` | `trusted`: validators named by at least `threshold` of the lists in use; `threshold`: how many lists must name one (absent while no publisher is known); `publishers`: one entry per configured publisher, by `id`. |
| publisher | `id` is the URL without scheme (`vl.ripple.com`); `public_key` the key it is configured with (66 hex digits); `status`: `ok` (a current list), `expired` (only an expired list, which is still used: a flagged old UNL is better than none) or `unavailable` (no list in use: none was ever fetched, or all the stored ones were served under a key the publisher no longer uses). With a list: its `sequence`, `version` (1 or 2), `expiration`, when it was `fetched`, the number of `validators` on it and how many of them were seen in 24 hours (`seen_24h`). `last_error` (the reason code) and `last_error_at` are there when the newest attempt to fetch the list failed, whatever the status. |
| `quorum` | `value`: the validations a ledger needs, derived with rippled's rule over the trusted UNL and the negative UNL, max(⌈0.8 × (`unl_size` − `negative_unl`)⌉, ⌈0.6 × `unl_size`⌉); `unl_size`: the trusted validators; `negative_unl`: how many of them are on the negative UNL. `node` is the quorum the node reports, only when it reports one above 0 (public nodes report 0). With no trusted validator `value` is 0. |
| `negative_unl` | The validators disabled now, `{validation_public_key, first_ledger}`; an empty list when none. `negative_unl_pending` is there only when a validator is about to be disabled or re-enabled: `{to_disable?, to_reenable?}`. |
| `fees` | `base_fee`, `reserve_base`, `reserve_inc` in whole units: those the node reported in the newest ledger state, else those in force at the newest voting round. |
| `next_flag_ledger` | The multiple of 256 above `ledger_index` and the `voting_ledger` before it (the ledger the validators' votes are counted at). `expected` is `close_time` plus the ledgers to go times the mean interval of the last 1,000 ledgers (the seconds they span over the ledgers they span, worked out exactly), rounded half up to the second. |
| `latest_version` | The newest release build among the versions the trusted validators reported in the last 24 hours. A release candidate or a beta is not one. |
| `versions` | The software versions of the trusted validators (`unl`) and of the validators seen in 24 hours (`all`), newest first: `{version, unl, all}`. A version is `major.minor.patch`, with `-rcN` or `-bN` for a candidate or a beta; on Xahau the major counts from 2023 (`2026.10.13`) and the builds of a version are one entry. |
| `versions_unknown` | The same two counts for the validators that reported no version (only a validation of a voting ledger carries one). |
| `agreement_through` | The end of the newest final hour of agreement. |
| `votes_through_ledger` | The newest voting ledger whose votes are computed. |
| `updated` | When the directory this answer comes from was built. |

An empty database answers 200 with `result`, `validators` (all 0), `unl` (`trusted` 0, no `publishers`), `quorum` (all 0), `negative_unl` (empty),
`versions` (empty), `versions_unknown` (both 0) and `updated`.

Errors: 500 `unable to retrieve validator(s)`.

**Differences from data.ripple.com**: the original has no such route; this one is new. It answers from the database only and does not wait for a node.

### `GET /v2/network/validators`

The validators of the network, one object each: how well each agrees with the network over the last hour, day and 30 days, its domain and whether the
domain's TOML file confirms it, the lists it is on, its software version, and what it votes for: fees and amendments. It is the table of the Validators
board.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `scope` | `unl` | `unl`: the trusted UNL, every member of it, seen or not (an offline member is a row too). `all`: the trusted UNL and every validator seen in the last 24 hours. Anything else answers 400 `invalid scope`. |
| `publisher` | | The `id` of a publisher of the [summary](#get-v2networkvalidatorssummary): only the validators on its list in use. Any other value answers 400 `invalid publisher`. |
| `amendment` | | The name or the ID (64 hex digits, either case) of an amendment: only the validators whose vote record names it. A name is matched as `GET /v2/network/amendments/{name}` matches it; a name no amendment has, and text that is neither a name nor an ID, answers 400 `invalid amendment`. An ID nobody voted for lists no validator. |
| `q` | | A part of the `domain`, the `validation_public_key` or the `signing_key`, in any case. More than 100 characters answers 400 `invalid search`. |
| `limit` | 200 (max 1000) | The size of a page. Smaller than 1 or not a number is the default. |
| `marker` | | From the previous page. Anything that is not a marker of this list answers 400 `invalid marker`. |
| `format` | `json` | `csv`: the rows as a CSV file named `validators.csv`, the nested objects flattened (`agreement_24h.score`, `unl_lists[0]`, `amendment_votes.yes[0].id`), one column for each key any row has, in the order they first appear. |

The parameters are checked in this order: `scope`, `publisher`, `amendment`, `q`, `marker`. An empty parameter is a missing one, a repeated one counts once (the
first), and parameters that are not listed are ignored. The filters and the scope apply together.

**Order.** The validators with a domain come first, by domain in lower case, then by master key; then the others, by master key. A `marker` is the place of
the last row in that order, `[group, sort text, master key]` (group 0 with a domain, group 1 without, whose sort text is empty), base64url: the next page starts
after it, even when its row has left the list since. The pages of any `limit` put together are the list without a `limit`. A page that is followed by more has the
`marker` and a `Link` header with the next URL, as the other lists have.

An example (`GET /v2/network/validators?limit=2` on the fleet of the e2e suite, 35 trusted validators; the two with a domain come first):

```
Link: <https://xrpl.data.example.com/v2/network/validators?limit=2&marker=WzAsInNob3JlbGluZS5leGFtcGxlIiwibkhVa0tvSnk4M0pwdEtjQjU2VDM4d1F3anZIM0VWWWRjdndBZkxESHdIN1FCa0xFdjRuRCJd>; rel="next"
```

```json
{
  "result": "success",
  "count": 2,
  "marker": "WzAsInNob3JlbGluZS5leGFtcGxlIiwibkhVa0tvSnk4M0pwdEtjQjU2VDM4d1F3anZIM0VWWWRjdndBZkxESHdIN1FCa0xFdjRuRCJd",
  "validators": [
    {
      "validation_public_key": "nHBFpmLgxtyCSPCW4fWLgqwefcLBuQdkU7R6FNQVF2B5czacYLLA",
      "domain": "northpeak.example",
      "current_index": 107748183,
      "agreement_1h": {"missed": 1, "total": 900, "score": "0.9989", "incomplete": false, "partial": 1},
      "agreement_24h": {"missed": 2, "total": 21600, "score": "0.9999", "incomplete": false, "partial": 1},
      "partial": false,
      "unl": true,
      "agreement_30d": {"missed": 3, "total": 43200, "score": "0.9999", "incomplete": true, "partial": 2},
      "signing_key": "n9Licf177qJUupBi7K4zt6ZTVToMGYgYZqCyTQSkmTSjywumRWso",
      "domain_verification": {
        "status": "verified",
        "toml_url": "https://northpeak.example/.well-known/xrp-ledger.toml",
        "checked": "2026-10-19T19:15:52.489Z",
        "verified": "2026-10-19T19:15:52.489Z",
        "accounts": ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"]
      },
      "unl_lists": ["unl.xrplf.org", "vl.ripple.com"],
      "negative_unl": false,
      "version": "3.4.1",
      "version_latest": true,
      "server_version": "1745992596280311808",
      "fee_vote": {"ledger_index": 107748095, "base_fee": "0.00001", "reserve_base": "1", "reserve_inc": "0.2"},
      "amendment_votes": {
        "ledger_index": 107748095,
        "yes": [
          {"id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76"}
        ]
      },
      "first_seen": "2026-07-21T19:25:53.000Z",
      "last_seen": "2026-10-19T19:24:52.750Z"
    },
    {
      "validation_public_key": "nHUkKoJy83JptKcB56T38wQwjvH3EVYdcvwAfLDHwH7QBkLEv4nD",
      "domain": "shoreline.example",
      "current_index": 107748183,
      "agreement_1h": {"missed": 0, "total": 900, "score": "1.0000", "incomplete": false, "partial": 0},
      "agreement_24h": {"missed": 1, "total": 21600, "score": "1.0000", "incomplete": false, "partial": 0},
      "partial": true,
      "unl": true,
      "agreement_30d": {"missed": 2, "total": 43200, "score": "1.0000", "incomplete": true, "partial": 1},
      "signing_key": "n9KvdobdhFC7Xwjshw7CxpWdfh8FFU3RHrFEYtpapEGkg3kANxTd",
      "domain_verification": {
        "status": "unverified",
        "reason": "not_listed",
        "toml_url": "https://shoreline.example/.well-known/xrp-ledger.toml",
        "checked": "2026-10-19T19:14:12.750Z"
      },
      "unl_lists": ["unl.xrplf.org", "vl.ripple.com"],
      "negative_unl": false,
      "version": "3.4.1",
      "version_latest": true,
      "server_version": "1745992596280311808",
      "fee_vote": {"ledger_index": 107748095, "base_fee": "0.00001", "reserve_base": "1", "reserve_inc": "0.2"},
      "amendment_votes": {
        "ledger_index": 107748095,
        "yes": [
          {"id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76"}
        ]
      },
      "first_seen": "2026-07-21T19:25:53.000Z",
      "last_seen": "2026-10-19T19:24:52.750Z"
    }
  ]
}
```

Keys of the validators answer, in order: `result, count, marker, validators`.

Keys of a validator row, in order: `validation_public_key, domain, current_index, agreement_1h, agreement_24h, partial, unl, agreement_30d, signing_key, domain_verification, unl_lists, negative_unl, version, version_build, version_latest, server_version, fee_vote, amendment_votes, first_seen, last_seen`.

Keys of an agreement window, in order: `missed, total, score, incomplete, partial`.

Keys of domain_verification, in order: `status, reason, status_code, toml_url, checked, verified, accounts`.

Keys of fee_vote, in order: `ledger_index, base_fee, reserve_base, reserve_inc`.

Keys of amendment_votes on a row of the list, in order: `ledger_index, yes`.

Keys of a yes entry, in order: `id, name`.

| Key | Meaning |
| --- | --- |
| `count`, `marker` | The rows of the page; `marker` only when more follow. |
| `validation_public_key` | The master key, base58. A validation or a vote recorded under a signing key counts for its master key (the manifests say which). |
| `domain` | The domain of the newest manifest. Absent without one, and when it is not a properly formed domain (rippled's `isProperlyFormedTomlDomain`: an IP address, a port, a path, a single label), which is then nowhere in the answer, the CSV included. This is what the validator claims; `domain_verification` says whether the domain confirms it. |
| `current_index`, `partial` | The ledger of the validator's newest validation among the last 300 ledgers, and whether that validation was partial (`true`) or full. Both absent when there is none. |
| `agreement_1h`, `agreement_24h`, `agreement_30d` | The validations the validator was held to over the newest final hour of agreement, the 24 hours and the 30 days (720 hours) ending with it: `missed` of `total` ledgers (the ledgers it agreed plus the ones it missed), `score` as text, `(total - missed) / total` to 4 decimals, rounded half up (absent when `total` is 0), `incomplete` when an hour of the window is not final yet or no data of it exists, or when more than 1 % of the validated ledgers of the window were left out for too few recorded validations, and `partial`, the partial validations counted. A validator that was never seen has all zeros. |
| `unl` | The validator is on the trusted UNL: named by at least `threshold` of the lists in use. |
| `signing_key` | The signing key of the newest manifest. Absent without a manifest. |
| `domain_verification` | Absent when the row has no `domain`. `status` is `verified`, `unverified` or `pending` (not checked yet). `reason` (the code) is there for `unverified` only, and `status_code` for its `http_status`. `toml_url` is the address the file is checked at (`/.well-known/xrp-ledger.toml`, on Xahau `/.well-known/xahau.toml`). `checked` is when the domain was last checked (absent while `pending`) and `verified` the last time it verified. `accounts` comes last, only for `verified`: the addresses of the `[[ACCOUNTS]]` of the file that verified, absent when it lists none. |
| `unl_lists` | The ids of the publishers whose list in use names the validator, sorted. Empty off the UNL. `negative_unl` is true while it is on the negative UNL. |
| `version`, `version_build`, `version_latest`, `server_version` | The software version in the newest `sfServerVersion` of the last 30 days (only a validation of a voting ledger carries one): `version` as the summary writes it (`3.4.1`, `-rcN`, `-bN`; on Xahau the year counts from 2023), `version_build` the build number after it (Xahau, when not 0), `version_latest` whether it is at least `latest_version` of the summary, `server_version` the number as reported, decimal text. All absent for a validator that reported none; an unrecognised number has `server_version` only. |
| `fee_vote` | The fees the validator votes for, in whole units, in its vote record: the newest full vote within 24 hours before the newest stored voting round, whether the validator is trusted or not. A fee the validation left out is the fee in force at that round. `ledger_index` is that round's voting ledger. Absent without a record. |
| `amendment_votes` | The amendments the record votes yes for, in the order of the record: `{id, name}`, `name` when the amendments know one. Absent without a record. |
| `first_seen`, `last_seen` | When this deployment first and last saw the validator (a signing key's sightings are its master's). Absent for a member of a list that was never seen. |

A member of the UNL that was never seen is a row too, with what its lists and its manifest give:

```json
{
  "validation_public_key": "nHUdgUruVBHqz9osBhZFz4yKvE1r68NDmpewqYDau3NPJiPnHm76",
  "agreement_1h": {"missed": 0, "total": 0, "incomplete": false, "partial": 0},
  "agreement_24h": {"missed": 0, "total": 0, "incomplete": false, "partial": 0},
  "unl": true,
  "agreement_30d": {"missed": 0, "total": 0, "incomplete": true, "partial": 0},
  "signing_key": "n9KNNXQTfTKSAucXQXbWDyCd48wU2MmyLeDvirY1Fd8sXKdkfqhw",
  "unl_lists": ["unl.xrplf.org", "vl.ripple.com"],
  "negative_unl": false
}
```

The list is built on the assembly of the amendments (it names the amendments, and holds the directory it was built on), so an answer can be up to about 20
seconds old; `Cache-Control: private, max-age=30`.

Errors: 400 `invalid scope`, `invalid publisher`, `invalid amendment`, `invalid search`, `invalid marker`; 500 `unable to retrieve validator(s)`.

**Differences from data.ripple.com**:

| Original | Here |
| --- | --- |
| Lists only validators whose last validation is less than 60 s old | `scope=unl` (default, includes offline UNL members) or `all` (adds validators seen in 24 h) |
| No paging | `limit` (200, max 1000), `marker`, `Link` |
| Sorted by chain, UNL first, 24 h score, domain, key | Domain-first alphabetical, then key (the board's order) |
| Row `{validation_public_key, domain, chain, current_index, agreement_1h, agreement_24h, partial, unl}` | The same keys in the same order, without `chain` (one network per deployment), then the new ones; agreement objects keep `{missed, total, score, incomplete}` and add `partial`; `agreement_30d` added |
| `unl` = on Ripple's main or altnet list | `unl` = on the trusted UNL of the configured publishers; `unl_lists` names them |
| `domain` from its own domain check | `domain` from the validator's manifest, `domain_verification` says whether the TOML confirms it |
| Agreement against the ledgers its chain logic saw | Against the indexed validated chain, full validations only, unobserved ledgers left out |
| Messages `Validator not found`, `unable to retrieve validator(s)`; CSV `validators.csv` | Kept; new 400s for the new parameters |
| `/manifests`, `/reports`, `/validator_reports`, `/rippled_versions` | Still 404 |

### `GET /v2/network/validators/{key}`

One validator: the object of the list, with its vote on every amendment still being decided, its manifest and its agreement of each of the last 30 days. JSON only:
`format` and the parameters of the list are ignored.

`key` is a master key (`nH...`) or a signing key (`n9...`), base58, or 66 hex digits starting `02`, `03` or `ED`, in either case (as the validator lists and the negative UNL
write them). A signing key answers with the validator it belongs to, through the manifests, and `validation_public_key` names the master; so does a signing key the
validator has since replaced. Any other text, `summary` and a classic address included, answers 400 `invalid validator public key`; a key of the right form that the
deployment has no record of answers 404 `Validator not found`. Every validator the deployment has seen or has on a list answers, however long ago it was last seen.

An example (the same validator, `northpeak.example`; `daily_agreement` is shortened to four of its 30 days, the first with no data and the last three):

```json
{
  "validation_public_key": "nHBFpmLgxtyCSPCW4fWLgqwefcLBuQdkU7R6FNQVF2B5czacYLLA",
  "domain": "northpeak.example",
  "current_index": 107748183,
  "agreement_1h": {"missed": 1, "total": 900, "score": "0.9989", "incomplete": false, "partial": 1},
  "agreement_24h": {"missed": 2, "total": 21600, "score": "0.9999", "incomplete": false, "partial": 1},
  "partial": false,
  "unl": true,
  "agreement_30d": {"missed": 3, "total": 43200, "score": "0.9999", "incomplete": true, "partial": 2},
  "signing_key": "n9Licf177qJUupBi7K4zt6ZTVToMGYgYZqCyTQSkmTSjywumRWso",
  "domain_verification": {
    "status": "verified",
    "toml_url": "https://northpeak.example/.well-known/xrp-ledger.toml",
    "checked": "2026-10-19T19:15:52.489Z",
    "verified": "2026-10-19T19:15:52.489Z",
    "accounts": ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"]
  },
  "unl_lists": ["unl.xrplf.org", "vl.ripple.com"],
  "negative_unl": false,
  "version": "3.4.1",
  "version_latest": true,
  "server_version": "1745992596280311808",
  "fee_vote": {"ledger_index": 107748095, "base_fee": "0.00001", "reserve_base": "1", "reserve_inc": "0.2"},
  "amendment_votes": {
    "ledger_index": 107748095,
    "yes": [
      {"id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76"}
    ],
    "votes": [
      {"id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76", "status": "voting", "vote": "yes"}
    ]
  },
  "first_seen": "2026-07-21T19:25:53.000Z",
  "last_seen": "2026-10-19T19:24:52.750Z",
  "manifest": {"sequence": 2, "signing_key": "n9Licf177qJUupBi7K4zt6ZTVToMGYgYZqCyTQSkmTSjywumRWso", "signing_keys_seen": 2, "domain": "northpeak.example"},
  "daily_agreement": [
    {"date": "2026-09-20", "missed": 0, "total": 0, "incomplete": true, "partial": 0},
    {"date": "2026-10-17", "missed": 0, "total": 4500, "score": "1.0000", "incomplete": true, "partial": 0},
    {"date": "2026-10-18", "missed": 1, "total": 21600, "score": "1.0000", "incomplete": false, "partial": 1},
    {"date": "2026-10-19", "missed": 2, "total": 17100, "score": "0.9999", "incomplete": true, "partial": 1}
  ],
  "result": "success"
}
```

The answer is the row, with `amendment_votes` in its place among the row's keys and always there, followed by the keys after the row.

Keys of amendment_votes on the validator answer, in order: `ledger_index, yes, votes`.

Keys of a vote entry, in order: `id, name, status, vote`.

Keys of the validator answer after the row, in order: `manifest, daily_agreement, result`.

Keys of manifest, in order: `sequence, signing_key, signing_keys_seen, domain`.

Keys of a daily agreement, in order: `date, missed, total, score, incomplete, partial`.

| Key | Meaning |
| --- | --- |
| `amendment_votes` | Always there. `yes` is the list's (the amendments the record votes yes for, enabled ones included). `votes` has one entry for each amendment whose status is `voting`, `majority` or `unknown`, in the order of `GET /v2/network/amendments`: `{id, name, status, vote}`, `vote` being `yes` or `no` as the record says. An `unknown` amendment (an ID the node lists without a name and nobody voted for) is in it too, without a `name`. A validator without a record has `vote` `none` for all of them, an empty `yes` and no `ledger_index`. |
| `manifest` | The newest manifest: its `sequence`, the `signing_key` it names, `signing_keys_seen`, the distinct signing keys stored for the master key (one less than that is how often the key was rotated), and its `domain` (absent as `domain` of the row is). Absent without a manifest. |
| `daily_agreement` | The 30 UTC days ending with the day of the newest final hour of agreement, the oldest first: `{date, missed, total, score, incomplete, partial}` as an agreement window, with `date` as `YYYY-MM-DD`. A day whose 24 hours are not all final is `incomplete`; one with no data has `total` 0 and no `score`. An empty list while no hour of agreement is final. |
| `result` | `success`, last. |

The votes on the amendments of the e2e suite's board for the first validator of its UNL (`amendment_votes`; the keys of the answer around it are left out):

```json
{
  "ledger_index": 107748095,
  "yes": [
    {"id": "B05DE10B9A021C900FC39DC73CAA31F5735A8657AF97122B9B24725A0D2DEC84", "name": "TestMajority"},
    {"id": "5DAA33FCBE27A650FDF1057665CE135F7CEAE8A7FD085D807E168B4945D7FF0D", "name": "TestVoting"},
    {"id": "53C82FC39AEA945DA2344727BD88EFA0DC54D0C52A82DDC656F9C8D9E3417C58", "name": "TestEnabledLedger"},
    {"id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76"},
    {"id": "1111111111111111111111111111111111111111111111111111111111111111", "name": "NodeNamedOnly"},
    {"id": "4444444444444444444444444444444444444444444444444444444444444444", "name": "StillVoted"}
  ],
  "votes": [
    {"id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76", "status": "majority", "vote": "yes"},
    {"id": "B05DE10B9A021C900FC39DC73CAA31F5735A8657AF97122B9B24725A0D2DEC84", "name": "TestMajority", "status": "majority", "vote": "yes"},
    {"id": "5DAA33FCBE27A650FDF1057665CE135F7CEAE8A7FD085D807E168B4945D7FF0D", "name": "TestVoting", "status": "voting", "vote": "yes"},
    {"id": "4444444444444444444444444444444444444444444444444444444444444444", "name": "StillVoted", "status": "voting", "vote": "yes"},
    {"id": "1111111111111111111111111111111111111111111111111111111111111111", "name": "NodeNamedOnly", "status": "voting", "vote": "yes"},
    {"id": "03C819CE74475971FB91BE4FD99A70045F25E820AF3D27231D1AA6E8CF838642", "name": "TestVotingIdle", "status": "voting", "vote": "no"},
    {"id": "5555555555555555555555555555555555555555555555555555555555555555", "status": "voting", "vote": "no"},
    {"id": "2222222222222222222222222222222222222222222222222222222222222222", "status": "unknown", "vote": "no"}
  ]
}
```

And for a member of the UNL that never voted (no record):

```json
{
  "yes": [],
  "votes": [
    {"id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76", "status": "majority", "vote": "none"},
    {"id": "B05DE10B9A021C900FC39DC73CAA31F5735A8657AF97122B9B24725A0D2DEC84", "name": "TestMajority", "status": "majority", "vote": "none"},
    {"id": "5DAA33FCBE27A650FDF1057665CE135F7CEAE8A7FD085D807E168B4945D7FF0D", "name": "TestVoting", "status": "voting", "vote": "none"},
    {"id": "4444444444444444444444444444444444444444444444444444444444444444", "name": "StillVoted", "status": "voting", "vote": "none"},
    {"id": "1111111111111111111111111111111111111111111111111111111111111111", "name": "NodeNamedOnly", "status": "voting", "vote": "none"},
    {"id": "03C819CE74475971FB91BE4FD99A70045F25E820AF3D27231D1AA6E8CF838642", "name": "TestVotingIdle", "status": "voting", "vote": "none"},
    {"id": "5555555555555555555555555555555555555555555555555555555555555555", "status": "voting", "vote": "none"},
    {"id": "2222222222222222222222222222222222222222222222222222222222222222", "status": "unknown", "vote": "none"}
  ]
}
```

The validator answer is built like the list, on the assembly of the amendments, and is up to about 20 seconds old; `Cache-Control: private, max-age=30`.

Errors: 400 `invalid validator public key`; 404 `Validator not found`; 500 `unable to retrieve validator(s)`.

**Differences from data.ripple.com**: the original answered this route with the same flat object, with the keys of its row; this one adds the keys of the new list row, the
vote on every amendment, the manifest and the daily agreement, and answers a validator seen long ago and a signing key. See the table above for the list.

### `GET /v2/network/validators/{key}/validations`

The validations one validator made in the last 7 days (the table keeps 7), newest first: for each ledger and ledger hash the sightings added up, whether the
ledger is the one the indexer holds, and when the validation was first and last seen.

`key` is taken as in `GET /v2/network/validators/{key}`: a master key (`nH...`) or a signing key (`n9...`), base58, or 66 hex digits starting `02`, `03` or `ED`, in either
case. A signing key answers with the validator it belongs to, and `validation_public_key` names the master. Any other text answers 400
`invalid validator public key`; a key of the right form that the deployment has no record of answers 404 `Validator not found`. A validator the deployment knows
that made no validation in the last 7 days answers an empty page.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `limit` | 200 | At most 1000; 0 or less is the default. |
| `marker` | | From the previous page: the base64url of `[ledger_index, ledger_hash]`, the key of the last validation of that page. Anything that is not one answers 400 `invalid marker`. |
| `descending` | `true` | Any text that contains `false`, in any case, lists the oldest first; any other text (or none) newest first. |
| `format` | `json` | `csv`: the page as a CSV file named `<validation_public_key> - validations.csv` (the master key, whichever key the path has), one row for each validation, the keys of a validation as columns. The columns come in the order the keys first appear, so `validated_hash`, which only a `different` validation has, comes last unless the first row has it. |

**Which rows.** The page lists the rows of the master key **and** of every signing key whose newest manifest names that master: a validation that the collector
recorded under a signing key before its manifest was known is the master's, as it is for every other figure of the validators. The sightings of one ledger and
hash under two of the keys are one validation: their `count` is summed, `first_datetime` is the earliest and `last_datetime` the latest of them, `full` is
true when any of them was full, and `signing_key` and `signing_time` are those of the earliest sighting. Two validations of the same `ledger_index` with different hashes (a
fork) are two rows, in the order of the hash. The page is cut after that merge, and a marker is the key of its last row.

An example (the e2e suite's validator with two signing keys, `limit=4`; the page has more, so it has a `marker`). The first row is a partial validation. The second and
third rows are two hashes of one ledger (a fork): the indexer holds the hash of the third, so the second is `different` and names it as `validated_hash`. The fourth row was
recorded under both the master key and an old signing key of it, three sightings in all; `signing_key` is that of the earliest, the old one:

```json
{
  "result": "success",
  "validation_public_key": "nHBFpmLgxtyCSPCW4fWLgqwefcLBuQdkU7R6FNQVF2B5czacYLLA",
  "count": 4,
  "marker": "WzEwNzc0ODAwNSwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwNjZDMUFBNSJd",
  "validations": [
    {
      "ledger_index": 107748007,
      "ledger_hash": "00000000000000000000000000000000000000000000000000000000066C1AA7",
      "validated": "matches",
      "full": false,
      "signing_key": "n9K1XhRwDoN8U2h49cSSzr8DLGNaoYmBdijREixAeM9rbWHjNSMv",
      "signing_time": "2026-10-19T16:26:20Z",
      "first_datetime": "2026-10-19T16:26:20.250Z",
      "last_datetime": "2026-10-19T16:26:20.250Z",
      "count": 1
    },
    {
      "ledger_index": 107748006,
      "ledger_hash": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "validated": "different",
      "validated_hash": "00000000000000000000000000000000000000000000000000000000066C1AA6",
      "full": true,
      "signing_key": "n9K1XhRwDoN8U2h49cSSzr8DLGNaoYmBdijREixAeM9rbWHjNSMv",
      "signing_time": "2026-10-19T16:26:16Z",
      "first_datetime": "2026-10-19T16:26:16.500Z",
      "last_datetime": "2026-10-19T16:26:16.500Z",
      "count": 1
    },
    {
      "ledger_index": 107748006,
      "ledger_hash": "00000000000000000000000000000000000000000000000000000000066C1AA6",
      "validated": "matches",
      "full": true,
      "signing_key": "n9K1XhRwDoN8U2h49cSSzr8DLGNaoYmBdijREixAeM9rbWHjNSMv",
      "signing_time": "2026-10-19T16:26:16Z",
      "first_datetime": "2026-10-19T16:26:16.250Z",
      "last_datetime": "2026-10-19T16:26:16.750Z",
      "count": 2
    },
    {
      "ledger_index": 107748005,
      "ledger_hash": "00000000000000000000000000000000000000000000000000000000066C1AA5",
      "validated": "matches",
      "full": true,
      "signing_key": "n9MQ1UFdKJmDsDsBauDdZ5VP6LjjDtnhzZ1NiKG6N5Rg8Pm75ncB",
      "signing_time": "2026-10-19T16:26:12Z",
      "first_datetime": "2026-10-19T16:26:12.250Z",
      "last_datetime": "2026-10-19T16:26:12.750Z",
      "count": 3
    }
  ]
}
```

Keys of the validations answer, in order: `result, validation_public_key, count, marker, validations`.

Keys of a validation, in order: `ledger_index, ledger_hash, validated, validated_hash, full, signing_key, signing_time, first_datetime, last_datetime, count`.

| Key | Meaning |
| --- | --- |
| `count` (answer), `marker` | The validations of the page; `marker` only when more follow (and a `Link: <...>; rel="next"` header, as in every list). |
| `validation_public_key` | The master key, base58. |
| `ledger_index`, `ledger_hash` | The ledger that was validated: the hash the validator signed. |
| `validated` | `matches`: the indexed ledger at that index has this hash. `different`: it has another, given as `validated_hash` (only then); the validator signed a ledger that is not the one of the indexed chain. `unknown`: no ledger is indexed at that index yet, or it lies outside the indexed history. |
| `full` | `true` for a full validation, `false` for a partial one. A validation seen both ways is `true`. |
| `signing_key`, `signing_time` | The signing key of the earliest sighting, and the time it signed (`YYYY-MM-DDTHH:mm:ssZ`; the validator sends it in seconds since 2000-01-01, which is converted). |
| `first_datetime`, `last_datetime` | When a collector first and last saw the validation (`YYYY-MM-DDTHH:mm:ss.SSSZ`). |
| `count` (validation) | How often the validation was seen: all the sightings, whatever key they were recorded under and however many partial rows they were written in. |

The page is read as every other list is ([ADR-0004](adr/0004-keyset-pagination.md)): one read for each of the keys (the master and its signing keys) in the order of the
table's key with a limit, so it costs what a page costs wherever it lies in the 7 days; the sightings are added up outside those reads, and the page is read again with more room when
partial rows fill the room; then one lookup of the ledgers of the page. `Cache-Control: private, max-age=5`; with a `marker`: `private, max-age=300`.

Errors: 400 `invalid validator public key`, `invalid marker`; 404 `Validator not found`; 500 `unable to retrieve validator(s)`.

### `GET /v2/network/amendments`

Every amendment the network knows: the enabled ones, the ones with a majority, the ones validators are voting on, the obsolete ones and the ones
nothing is known of. With each, its status, the votes it has in the newest voting round, and, for an enabled one, when it was enabled. About 120 on
XRPL, so there is no paging. The answer also states the rules of the network, the newest stored round and the next flag ledger, so that the Amendments
board needs no other call for them.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `status` | all | A comma list of `enabled`, `majority`, `voting`, `obsolete` and `unknown`: only the amendments of those statuses are listed (in the order of the list), but `counts` still counts all of them. A parameter that is empty is all. Anything else answers 400 `invalid status`. |
| `format` | `json` | `csv`: the amendments as a CSV file named `amendments.csv`, one row each, the nested objects flattened (`votes.yes`, `majority.since`). |

An example (the e2e suite's board: 13 amendments, 7 of which are shown here; the rows left out are of the same shapes):

```json
{
  "result": "success",
  "ledger_index": 107748183,
  "rules": {"threshold_percent": 80, "majority_hold_seconds": 1209600, "flag_interval": 256},
  "round": {"ledger_index": 107748095, "date": "2026-10-19T15:48:20Z", "unl_size": 36, "trusted": 35, "threshold": 28, "needed": 29, "observed": 35},
  "next_flag_ledger": {"ledger_index": 107748352, "voting_ledger": 107748351, "expected": "2026-10-19T16:05:28Z"},
  "counts": {"enabled": 3, "majority": 2, "voting": 5, "obsolete": 2, "unknown": 1},
  "count": 13,
  "amendments": [
    {
      "id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76",
      "status": "majority",
      "votes": {"ledger_index": 107748095, "yes": 30, "trusted": 35, "needed": 29, "pct": 85.71},
      "majority": {"since": "2026-10-14T15:54:20Z", "expected_activation": "2026-10-28T15:54:20Z"}
    },
    {
      "id": "B05DE10B9A021C900FC39DC73CAA31F5735A8657AF97122B9B24725A0D2DEC84",
      "name": "TestMajority",
      "status": "majority",
      "introduced": "3.4.1",
      "xls": "XLS-99",
      "xls_url": "https://github.com/XRPLF/XRPL-Standards/discussions/99",
      "node_supported": true,
      "votes": {"ledger_index": 107748095, "yes": 31, "trusted": 35, "needed": 29, "pct": 88.57},
      "majority": {"since": "2026-10-17T15:54:20Z", "ledger_index": 107704833, "tx_hash": "F78430ADBAF1464366DC4AAA169171604FFD56A9BB28F27835A80EDB455F7ED4", "expected_activation": "2026-10-31T15:54:20Z"}
    },
    {
      "id": "5DAA33FCBE27A650FDF1057665CE135F7CEAE8A7FD085D807E168B4945D7FF0D",
      "name": "TestVoting",
      "status": "voting",
      "introduced": "3.5.0",
      "description": "Made up for the tests: voted for by four.",
      "node_supported": true,
      "votes": {"ledger_index": 107748095, "yes": 4, "trusted": 35, "needed": 29, "pct": 11.43}
    },
    {
      "id": "2222222222222222222222222222222222222222222222222222222222222222",
      "status": "unknown",
      "node_supported": true,
      "votes": {"ledger_index": 107748095, "yes": 0, "trusted": 35, "needed": 29, "pct": 0}
    },
    {
      "id": "53C82FC39AEA945DA2344727BD88EFA0DC54D0C52A82DDC656F9C8D9E3417C58",
      "name": "TestEnabledLedger",
      "status": "enabled",
      "introduced": "1.12.0",
      "xls": "XLS-30",
      "xls_url": "https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0030-automated-market-maker",
      "description": "Made up for the tests: enabled, with an indexed EnableAmendment that wins over the file.",
      "node_supported": true,
      "enabled": {"ledger_index": 107747841, "date": "2026-10-19T15:31:24Z", "tx_hash": "F5AFF7C2C2CD3F3CD74221F3D78C190BAAF45B3A6867CD165CB0253679EE0C6E", "source": "ledger"}
    },
    {
      "id": "4E9CC7512DFA8BA60E7571CBA7DC44DC7948739B4E342D9E18AE0B8F20B224F0",
      "name": "TestEnabledFile",
      "status": "enabled",
      "introduced": "2.0.0",
      "enabled": {"ledger_index": 90000001, "date": "2025-02-03", "source": "metadata"}
    },
    {
      "id": "1ED1958A27DE4444C02559D145D2479ABE8A3C98A690DB993A48303779444A09",
      "name": "TestObsolete",
      "status": "obsolete",
      "introduced": "0.60.0"
    }
  ]
}
```

Keys of the amendments answer, in order: `result, ledger_index, rules, round, next_flag_ledger, counts, count, amendments`.

Keys of the newest round, in order: `ledger_index, date, unl_size, trusted, threshold, needed, observed`.

Keys of an amendment row, in order: `id, name, status, retired, introduced, xls, xls_url, description, node_supported, votes, majority, enabled`.

Keys of votes, in order: `ledger_index, yes, trusted, needed, pct`.

Keys of majority, in order: `since, ledger_index, tx_hash, expected_activation`.

Keys of enabled, in order: `ledger_index, date, tx_hash, source`.

A key without a value is absent. In particular `name`, `introduced`, `xls`, `xls_url`, `description`, `node_supported`, `retired`, `votes`, `majority` and `enabled` are there
only when they have a value, and `ledger_index`, `round` and `next_flag_ledger` are absent from the answer of a database that has no ledger, no round or no head yet.

| Key | Meaning |
| --- | --- |
| `ledger_index` | The newest committed ledger of the index: the summary's. |
| `rules` | The rules of the network: `threshold_percent` (80: an amendment needs more than that share of the trusted validators), `majority_hold_seconds` (how long it must hold its majority before it is enabled: 1,209,600 on XRPL, 432,000 on Xahau) and `flag_interval` (256). |
| `round` | The newest voting round stored: its voting `ledger_index`, `date` (its close time), `unl_size` (the validators on the UNL), `trusted` (the ones of them with a vote record, the ones that count), `threshold` (the votes an amendment has to exceed: max(1, ⌊`trusted` × 80 / 100⌋)), `needed` (the votes that pass: `threshold` + 1, and 1 when `trusted` is 1 or less) and `observed` (the validators of the UNL whose full validation of the voting ledger was seen). Absent while no round is stored. |
| `next_flag_ledger` | The summary's: the next multiple of 256 and the voting ledger before it, and when it is expected. |
| `counts` | How many amendments there are of each status, all of them, whatever `status` asks for. |
| `count` | The number of amendments listed. |
| `amendments` | The amendments, in the order below. |
| `id` | The ID: 64 hex digits, upper case. It is the SHA-512Half of the name. |
| `name` | The name of the amendment: the one in the metadata file, else the one the node gives (the node may not know a name: public nodes lack the one of an amendment that is new), else absent. |
| `status` | One of the five below. |
| `retired` | `true` for a name of the metadata file that is retired (Xahau: behaviour that is always on although the ledger does not list the name). |
| `introduced`, `xls`, `xls_url`, `description` | From the metadata file (names, descriptions and links of the standards: `GH_AMENDMENTS_CONFIG`, a file per network that ships with the API): the software version that introduced it (a rippled version on XRPL, a xahaud date version on Xahau), the standard (`XLS-30`) and its address, which always lies under `https://github.com/XRPLF/XRPL-Standards/`, and one line about it. Absent for an amendment the file does not have. |
| `node_supported` | Whether the node says it supports the amendment, when it lists it. |
| `votes` | For an amendment that is `majority`, `voting` or `unknown`, when a round is stored: what the newest round says. `ledger_index` is its voting ledger, `yes` the trusted validators with the amendment in their vote record (0 when the round has no tally of it), `trusted` and `needed` as in `round`, `pct` = `yes` / `trusted` × 100 to two decimals, rounded half up (0 when `trusted` is 0). |
| `majority` | For an amendment that has a majority: `since`, the close time of the ledger that recorded it; `ledger_index` and `tx_hash`, of the newest indexed `EnableAmendment` that gave it the majority (absent when none is indexed: the majority was gained before the indexed history, or the index has not reached that ledger yet; and absent when a `lost_majority` or an enabling of the amendment is indexed after it: the majority it has now was regained and its transaction is not indexed yet); `expected_activation`, `since` plus the hold. It is enabled by the first flag ledger after that, in the ledger after the flag ledger. |
| `enabled` | For an enabled amendment: `ledger_index`, `date` (the close time) and `tx_hash` of the indexed `EnableAmendment` that enabled it, with `source` `ledger`; else what the metadata file says, `ledger_index` and `date` (a day, `YYYY-MM-DD`; either may be missing), with `source` `metadata`; else none. A retired name has one only when the ledger has it. |

**Status.** The first row that matches:

| Status | When |
| --- | --- |
| `enabled` | The ledger lists it as enabled; or the file calls it `retired`. |
| `majority` | The ledger lists a majority for it. |
| `obsolete` | The file calls it `obsolete`; or the node does not support it and no validator of the trusted UNL votes yes in the newest round. |
| `voting` | The node or the file names it, or any validator voted for it in the last 30 days. |
| `unknown` | The rest: the node lists it without a name, and nobody voted for it. |

**Order.** The groups come in the order `majority`, `voting`, `unknown`, `enabled`, `obsolete`. Inside a group: `majority` by `expected_activation`; `voting` by `votes.yes`, most
first, then by name; `unknown` by ID; `enabled` by the ledger it was enabled in, the newest first (the ones without one last, by name); `obsolete` by name. A name is compared without regard to case, a
named amendment comes before an unnamed one, and an unnamed one is compared by its ID.

The amendments are assembled from the newest ledger state, what the node says of each ID (`feature`), the metadata file, the votes of the last 30 days and the indexed `EnableAmendment` transactions, and kept
for up to 10 seconds (counted from the start of the build), one build at a time per replica, on top of a directory that can be up to 10 seconds old: an answer can be up to about 20 seconds old. Every read of
votes and tallies takes the newest version written of a round, and the newest round is the directory's, with the version it read, so that `round`, `votes` and the votes of the validators agree.

Errors: 400 `invalid status`; 500 `unable to retrieve amendments`. `Cache-Control: private, max-age=60`.

**Differences from data.ripple.com**: the original has no such route; this one is new. It answers from the database only and does not wait for a node.

### `GET /v2/network/amendments/{name}`

One amendment, by its name or its ID. `name` is a name as it is written, else a name in any other case when only one amendment has it, or the 64 hex digits of an ID in either case. Anything else answers
404 `amendment not found`. JSON only: `format` is ignored.

The answer starts with the envelope of the list (`ledger_index`, `rules`, `round`, `next_flag_ledger`: the same values, so that a page of one amendment needs no call of the list for them), then the
amendment as the list has it, then how the validators vote on it, its rounds and its history.

An example (`TestMajority` of the e2e suite's board; `unl_votes` is shortened to five of the 36 members of the UNL, whose first two are the ones with a domain, listed first):

```json
{
  "ledger_index": 107748183,
  "rules": {"threshold_percent": 80, "majority_hold_seconds": 1209600, "flag_interval": 256},
  "round": {"ledger_index": 107748095, "date": "2026-10-19T15:48:20Z", "unl_size": 36, "trusted": 35, "threshold": 28, "needed": 29, "observed": 35},
  "next_flag_ledger": {"ledger_index": 107748352, "voting_ledger": 107748351, "expected": "2026-10-19T16:05:28Z"},
  "id": "B05DE10B9A021C900FC39DC73CAA31F5735A8657AF97122B9B24725A0D2DEC84",
  "name": "TestMajority",
  "status": "majority",
  "introduced": "3.4.1",
  "xls": "XLS-99",
  "xls_url": "https://github.com/XRPLF/XRPL-Standards/discussions/99",
  "node_supported": true,
  "votes": {"ledger_index": 107748095, "yes": 31, "trusted": 35, "needed": 29, "pct": 88.57},
  "majority": {"since": "2026-10-17T15:54:20Z", "ledger_index": 107704833, "tx_hash": "F78430ADBAF1464366DC4AAA169171604FFD56A9BB28F27835A80EDB455F7ED4", "expected_activation": "2026-10-31T15:54:20Z"},
  "unl_votes": [
    {"validation_public_key": "nHBFpmLgxtyCSPCW4fWLgqwefcLBuQdkU7R6FNQVF2B5czacYLLA", "domain": "northpeak.example", "vote": "yes", "version": "3.4.1", "version_supports": true, "last_seen": "2026-10-19T15:53:19.750Z"},
    {"validation_public_key": "nHUkKoJy83JptKcB56T38wQwjvH3EVYdcvwAfLDHwH7QBkLEv4nD", "domain": "shoreline.example", "vote": "yes", "version": "3.4.1", "version_supports": true, "last_seen": "2026-10-19T15:53:19.750Z"},
    {"validation_public_key": "nHUQGzW4J3ZH3mms7Dhf6FyuJWXGYzX5A8sYwnX4TWwRYdkJU1pv", "vote": "yes", "version": "3.4.0", "version_supports": false, "last_seen": "2026-10-19T15:53:19.750Z"},
    {"validation_public_key": "nHBZUmz9mhzGE2XnNd1S3LAxwT7NMwToY2SsdAMBYfaemcr3pJaD", "vote": "no", "version": "3.4.0", "version_supports": false, "last_seen": "2026-10-19T15:53:19.750Z"},
    {"validation_public_key": "nHUZzKfNLsYGbfKCqEqgy2uk76JZqoHWQjt2wrm5t39Jads1g2kQ", "vote": "none", "last_seen": "2026-10-19T15:53:19.750Z"}
  ],
  "other_votes": [
    {"validation_public_key": "nHBSrmG2Ng7SERr69XRdEsP1qLfENMmbn4oc7SN6bZJjkadfqnKC", "domain": "tidewater.example", "vote": "yes", "version": "3.4.1", "version_supports": true, "last_seen": "2026-10-19T15:53:19.750Z"},
    {"validation_public_key": "nHU6XWBJQH7SQuDmC59hwWLmbN2uWUGBzm2pU698DuHnVDE68srx", "vote": "no", "version": "3.5.0", "version_supports": true, "last_seen": "2026-10-19T15:53:19.750Z"}
  ],
  "rounds": [
    {"ledger_index": 107543295, "flag_ledger": 107543296, "date": "2026-10-09T15:54:20Z", "yes": 0, "trusted": 35, "threshold": 28, "passes": false},
    {"ledger_index": 107747327, "flag_ledger": 107747328, "date": "2026-10-19T14:57:08Z", "yes": 25, "trusted": 35, "threshold": 28, "passes": false},
    {"ledger_index": 107747583, "flag_ledger": 107747584, "date": "2026-10-19T15:14:12Z", "yes": 29, "trusted": 35, "threshold": 28, "passes": true},
    {"ledger_index": 107747839, "flag_ledger": 107747840, "date": "2026-10-19T15:31:16Z", "yes": 31, "trusted": 35, "threshold": 28, "passes": true},
    {"ledger_index": 107748095, "flag_ledger": 107748096, "date": "2026-10-19T15:48:20Z", "yes": 31, "trusted": 35, "threshold": 28, "passes": true}
  ],
  "history": [
    {"event": "got_majority", "ledger_index": 106500001, "date": "2026-08-20T15:54:20Z", "tx_hash": "62C1656A2A1702F45C414DB330DBBEA25FDA830A80131B0C56BE514A7B6B68B1"},
    {"event": "lost_majority", "ledger_index": 106600001, "date": "2026-08-30T15:54:20Z", "tx_hash": "322F9E58EDBEEB643D949CF33F3FD6D0049E537B493EB08D262446CBD9C189E1"},
    {"event": "got_majority", "ledger_index": 107704833, "date": "2026-10-17T15:54:25Z", "tx_hash": "F78430ADBAF1464366DC4AAA169171604FFD56A9BB28F27835A80EDB455F7ED4"}
  ],
  "result": "success"
}
```

Keys of the amendment answer, in order: `ledger_index, rules, round, next_flag_ledger, id, name, status, retired, introduced, xls, xls_url, description, node_supported, votes, majority, enabled, unl_votes, other_votes, rounds, history, result`.

Keys of a UNL vote, in order: `validation_public_key, domain, vote, version, version_supports, last_seen`.

Keys of a round, in order: `ledger_index, flag_ledger, date, yes, trusted, threshold, passes`.

Keys of a history event, in order: `event, ledger_index, date, tx_hash`.

| Key | Meaning |
| --- | --- |
| `unl_votes` | Every validator on the UNL of the newest round, in the order of the validators list (the ones with a domain first, by domain, then the rest by key). `vote` is `yes` or `no` as the record the round counts for it says (its newest full vote within 24 hours, from a round where it was on the UNL and not on the negative UNL), `none` without such a record. `domain` is the one of its newest manifest; `version` the software version it reported most recently in the last 30 days; `version_supports` is true when that version is at least `introduced` (it is absent when either is unknown); `last_seen` is when this deployment last saw the validator (`YYYY-MM-DDTHH:mm:ss.SSSZ`). A validator is keyed by its master key, whichever key signed its votes. |
| `other_votes` | The validators that are not on the UNL of the newest round, were seen in the last 24 hours and have a vote record: the same objects, `vote` being `yes` or `no`. |
| `rounds` | One per stored voting round of the last 30 days, the oldest first (about 2,600 on XRPL): `ledger_index` is the voting ledger and `flag_ledger` the one after it, `date` its close time, `yes` the votes the amendment had in it (0 when the round has no tally of it), `trusted` and `threshold` those of the round, and `passes` whether `yes` carried it: more than `threshold` (at least `threshold` when `trusted` is 1). An amendment that is `enabled` has only the rounds before the ledger it was enabled in, and none when that ledger is not known. |
| `history` | Every indexed `EnableAmendment` of the amendment, the oldest first: `event` is `got_majority` (`tfGotMajority`), `lost_majority` (`tfLostMajority`) or `enabled` (no flags), with its `ledger_index`, the close time of the ledger as `date`, and its `tx_hash`. |
| `result` | `success`, last. |

Errors: 404 `amendment not found`; 500 `unable to retrieve amendments`. `Cache-Control: private, max-age=60`.

**Differences from data.ripple.com**: the original has no such route; this one is new.

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

