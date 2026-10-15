# GateHub XRPL Data API — Reference

Historical XRP Ledger data — payments, transactions, ledgers, exchanges, accounts and
network analytics — served from ClickHouse, with a small set of live endpoints that read
directly from an XRPL node.

This document is a hand-written companion to the machine-generated OpenAPI spec. The same
spec is served live by the running service at [`/internal/docs/json`](#operational-endpoints)
and rendered as Swagger UI at [`/internal/docs`](#operational-endpoints). A static copy
lives at [`docs/openapi.yaml`](./openapi.yaml).

---

## 1. Overview

| | |
|---|---|
| **Production base URL** | `https://api.gatehub.net/data-api` |
| **Local base URL** | `http://localhost:3001` |
| **API version** | URI versioning — every resource route is prefixed with `/v2` |
| **Request content type** | none required (all endpoints are `GET`, no request bodies) |
| **Success content type** | `application/json` |
| **Error content type** | `application/problem+json` (RFC 7807) |

### Versioning

The API uses **URI versioning**. The current major version is `v2`, so every business
endpoint is reachable at `…/v2/<resource>`. For example, in production:

```
https://api.gatehub.net/data-api/v2/payments
```

Operational endpoints (`/liveliness/healthz`, `/metricz`, `/internal/docs*`) are **not**
versioned and are served at the root.

### Reverse proxy / TLS

The service always runs behind the GateHub reverse proxy, which terminates TLS and performs
edge routing. The application itself listens on plain HTTP (`GH_HTTP_API_PORT`, default
`3001`) and trusts the proxy's `X-Forwarded-For` header to resolve the real client IP
(`GH_TRUST_PROXY_HOPS`, default `1` hop). That client IP is used for per-client rate limiting
and logging. Always call the public HTTPS URL — never the upstream HTTP port directly.

---

## 2. Authentication

All business endpoints require an API key. Supply it in **one** of two headers:

```
X-API-Key: <your-key>
```

or the standard bearer form:

```
Authorization: Bearer <your-key>
```

Notes:

- The key must be sent in a **header**, never a query string (query params leak into access
  logs, browser history and referrers).
- Keys are compared in **constant time**.
- If the server is started with **no keys configured** (`GH_API_KEYS` empty), authentication
  is disabled entirely — intended for local/dev only. In production an empty key set logs a
  loud warning and serves the API unauthenticated.

### Open (unauthenticated) paths

These paths are always allowed without a key so probes and scrapers work:

| Path pattern | Purpose |
|---|---|
| `/liveliness/*` | liveness / health probe |
| `/metricz` | Prometheus metrics scrape |
| `/internal/docs*` | Swagger UI and OpenAPI JSON |

### 401 behavior

A missing or invalid key on a protected endpoint returns **401 Unauthorized** as an RFC 7807
problem document:

```json
{
  "type": "https://docs.gatehub.net/data-api/errors/401",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Missing or invalid API key.",
  "instance": "/v2/payments"
}
```

---

## 3. Conventions

### List envelope

List endpoints wrap their rows in a standard envelope:

```json
{
  "result": "success",
  "marker": "<opaque-cursor-or-absent>",
  "count": 200,
  "<items>": [ ... ]
}
```

| Field | Type | Description |
|---|---|---|
| `result` | string | Always `"success"` on a 2xx response. |
| `marker` | string \| absent | Opaque pagination cursor. Present only when more pages may exist (see below). |
| `count` | integer | Number of items in **this** page (`<items>.length`). |
| `<items>` | array | The result rows. The key name varies by endpoint: `payments`, `transactions`, `ledgers`, `exchanges`, `accounts`, `balance_changes`, `currencies`, `stats`, `reports`, `orders`, `balances`. |

> Some aggregate/analytic endpoints (single-resource lookups, volumes, rates, normalize,
> account stats) return a bespoke shape rather than the list envelope. These are noted per
> endpoint below.

### Cursor (keyset) pagination

List endpoints use **keyset / cursor** pagination — not page numbers or offsets. The cursor
is an **opaque base64url token** (`marker`) that encodes the sort-key tuple of the last row
returned.

To page through results:

1. Make the first request without a `marker`.
2. Read `marker` from the response.
3. Pass it back as the `marker` query parameter to fetch the next page (keeping all other
   params — `limit`, `descending`, filters — identical).
4. **When `marker` is absent in a response, you have reached the end.**

`marker` is omitted whenever a page is not full (`count < limit`) — i.e. there is no next
page. Treat the token as opaque; do not parse or construct it yourself.

```bash
# page 1
curl -s 'https://api.gatehub.net/data-api/v2/payments?limit=200' \
  -H 'X-API-Key: <key>'

# page 2 — reuse the marker from page 1's response
curl -s 'https://api.gatehub.net/data-api/v2/payments?limit=200&marker=WyIyMDI0LTAxLTAxIDAwOjAwOjAwIiw4MDAwMDAwMCwwXQ' \
  -H 'X-API-Key: <key>'
```

### Common query parameters

Most list endpoints accept these shared parameters:

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `start` | string (ISO-8601) | no | — | Inclusive lower time bound. Example: `2024-01-01T00:00:00Z`. |
| `end` | string (ISO-8601) | no | — | Inclusive upper time bound. Example: `2024-12-31T23:59:59Z`. |
| `limit` | integer | no | `200` | Max rows to return. Range `1`–`1000`. Out-of-range values fail validation (400). |
| `descending` | boolean | no | `false` | Sort newest-first when `true`. Accepts `true`/`false`/`1`/`0`. |
| `marker` | string | no | — | Opaque pagination cursor from the previous response. |
| `format` | enum | no | `json` | Response format. One of `json`, `csv`. |

> Unknown query parameters are **rejected** with a 400 (the API runs a strict
> whitelist validator). Send only documented params.

### Time handling

- All time **inputs** (`start`, `end`, `date`, `ledger` dates) are ISO-8601.
- All time **outputs** (`date`, `close_time`, candle `start`, etc.) are returned as
  ISO-8601 UTC strings, e.g. `2024-01-01T00:00:00.000Z`.

---

## 4. Errors (RFC 7807)

Every error is rendered as `application/problem+json` with this shape:

| Field | Type | Description |
|---|---|---|
| `type` | string | URI reference for the error class, e.g. `https://docs.gatehub.net/data-api/errors/404`. `about:blank` for unexpected 500s. |
| `title` | string | Human-readable status title, e.g. `Not Found`. |
| `status` | integer | HTTP status code. |
| `detail` | string | Human-readable explanation. For 5xx this is a generic message (internal details are not leaked; they are logged server-side). |
| `instance` | string | The request path that produced the error. |
| `errors` | string[] | Present on validation failures — one message per failed field. |

Example validation error (400):

```json
{
  "type": "https://docs.gatehub.net/data-api/errors/400",
  "title": "Bad Request",
  "status": 400,
  "detail": "Bad Request",
  "instance": "/v2/payments",
  "errors": [
    "limit must not be greater than 1000",
    "start must be a valid ISO 8601 date string"
  ]
}
```

### Common statuses

| Status | Title | When |
|---|---|---|
| `400` | Bad Request | Invalid/unknown query param, bad value (e.g. `limit > 1000`, non-ISO date), or an unparseable resource identifier. `errors[]` lists the offending fields. |
| `401` | Unauthorized | Missing or invalid API key on a protected endpoint. |
| `404` | Not Found | Resource does not exist (`transaction-not-found`, `ledger-not-found`, `account-not-found`). |
| `429` | Too Many Requests | Rate limit exceeded (see below). |
| `500` | Internal Server Error | Unexpected failure. `detail` is generic (`"An unexpected error occurred."`). |

---

## 5. Rate limiting

Requests are throttled **per client**, keyed on the real client IP (resolved from
`X-Forwarded-For` via the trusted reverse proxy).

- **Default window:** 60 seconds.
- **Default limit:** 600 requests per window per client.
- Exceeding the limit returns **429 Too Many Requests** as an RFC 7807 problem document.

Both the limit and the window are configurable per deployment (`GH_RATE_LIMIT`,
`GH_RATE_LIMIT_WINDOW`), so treat the numbers above as the documented production defaults
rather than a contract. Clients should back off on a 429 and retry.

---

## 6. Endpoint reference

All paths below are relative to the base URL and include the `/v2` version prefix. Curl
examples use the production base URL and the `X-API-Key` header.

### Tag: payments

Indexed (ClickHouse). Returns `Payment` transactions.

#### `GET /v2/payments` — List payments

List payment transactions, oldest- or newest-first, with cursor pagination.

**Query params:** `start`, `end`, `limit`, `descending`, `marker`, `format` (all common), plus:

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `currency` | string | no | — | Filter by currency code (e.g. `XRP`, `USD`). |
| `issuer` | string | no | — | Filter by issuer address (for IOU currencies). |

```bash
curl -s 'https://api.gatehub.net/data-api/v2/payments?currency=USD&limit=2&descending=true' \
  -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "marker": "WyIyMDI0LTAxLTAxIDAwOjAwOjAwIiw4MDAwMDAwMCwzXQ",
  "count": 2,
  "payments": [
    {
      "ctid": "C08F0F2400030000",
      "tx_hash": "F3A1...C2",
      "source": "rSourceAddr...",
      "destination": "rDestAddr...",
      "currency": "USD",
      "issuer": "rIssuerAddr...",
      "amount": 100.5,
      "delivered_amount": 100.5,
      "source_currency": "USD",
      "max_amount": 101.0,
      "fee": 0.00001,
      "source_tag": null,
      "destination_tag": 12345,
      "invoice_id": "",
      "date": "2024-01-01T00:00:00.000Z",
      "ledger_index": 80000000,
      "tx_index": 3,
      "client": ""
    }
  ]
}
```

#### `GET /v2/payments/{currency}` — List payments for a currency

Convenience route equivalent to `GET /v2/payments?currency={currency}`.

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `currency` | path | string | yes | Currency code, e.g. `USD`. |

Accepts the same query params as `GET /v2/payments` (`issuer`, plus all common params).
Returns the same `payments` envelope.

```bash
curl -s 'https://api.gatehub.net/data-api/v2/payments/USD?limit=50' -H 'X-API-Key: <key>'
```

---

### Tag: transactions

Indexed (ClickHouse). Full XRPL transaction JSON and metadata.

#### `GET /v2/transactions` — List transactions

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | string | no | — | XRPL transaction type, e.g. `Payment`, `OfferCreate`. |
| `result` | string | no | — | Engine result, e.g. `tesSUCCESS`. |
| common | — | no | — | `start`, `end`, `limit`, `descending`, `marker`, `format`. |

```bash
curl -s 'https://api.gatehub.net/data-api/v2/transactions?type=Payment&result=tesSUCCESS&limit=1' \
  -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "marker": "WyIyMDI0LTAxLTAxIDAwOjAwOjAwIiw4MDAwMDAwMCw1XQ",
  "count": 1,
  "transactions": [
    {
      "hash": "AB12...EF",
      "ledger_index": 80000000,
      "tx_index": 5,
      "type": "Payment",
      "account": "rSenderAddr...",
      "result": "tesSUCCESS",
      "date": "2024-01-01T00:00:00.000Z",
      "tx": {
        "TransactionType": "Payment",
        "Account": "rSenderAddr...",
        "Destination": "rDestAddr...",
        "Amount": "1000000",
        "Fee": "12",
        "Sequence": 42
      }
    }
  ]
}
```

> Each list item includes the parsed `tx` JSON but **not** `meta`. Use the by-hash endpoint
> for transaction metadata.

#### `GET /v2/transactions/{hash}` — Get a transaction by hash

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `hash` | path | string | yes | Transaction hash. |
| `binary` | query | boolean | no (default `false`) | When `true`, return `tx` and `meta` as hex-encoded binary instead of JSON. |

Returns **404** (`transaction-not-found`) if the hash is unknown.

```bash
curl -s 'https://api.gatehub.net/data-api/v2/transactions/AB12...EF' -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "transaction": {
    "hash": "AB12...EF",
    "ledger_index": 80000000,
    "date": "2024-01-01T00:00:00.000Z",
    "tx": {
      "TransactionType": "Payment",
      "Account": "rSenderAddr...",
      "Destination": "rDestAddr...",
      "Amount": "1000000",
      "Fee": "12"
    },
    "meta": {
      "TransactionResult": "tesSUCCESS",
      "delivered_amount": "1000000",
      "AffectedNodes": []
    }
  }
}
```

With `?binary=true`, `tx` and `meta` are hex strings.

---

### Tag: ledgers

Indexed (ClickHouse).

#### `GET /v2/ledgers` — List ledgers in a time range

Common params only: `start`, `end`, `limit`, `descending`, `marker`, `format`. Time filtering
is on `close_time`.

```bash
curl -s 'https://api.gatehub.net/data-api/v2/ledgers?start=2024-01-01T00:00:00Z&limit=1' \
  -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "marker": "WyIyMDI0LTAxLTAxIDAwOjAwOjAwIiw4MDAwMDAwMF0",
  "count": 1,
  "ledgers": [
    {
      "ledger_hash": "C7E3...9A",
      "ledger_index": 80000000,
      "parent_hash": "B6D2...18",
      "total_coins": "99989765432109876",
      "close_time_res": 10,
      "account_hash": "A1B2...CD",
      "transaction_hash": "E5F6...78",
      "close_time": "2024-01-01T00:00:00.000Z",
      "close_time_human": "2024-Jan-01 00:00:00.000000000 UTC",
      "tx_count": 35
    }
  ]
}
```

#### `GET /v2/ledgers/{identifier}` — Get a ledger by index, hash or date

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `identifier` | path | string | yes | One of: a numeric **ledger index**; a 64-char hex **ledger hash**; or an **ISO date** (returns the first ledger closed at/after that time). |

Returns **400** for an unparseable identifier; **404** (`ledger-not-found`) if no match.

```bash
curl -s 'https://api.gatehub.net/data-api/v2/ledgers/80000000' -H 'X-API-Key: <key>'
```

Response: `{ "result": "success", "ledger": { ...same fields as a list item... } }`.

---

### Tag: exchanges

Indexed (ClickHouse). DEX trades, OHLC/VWAP candles, exchange rates, and amount conversion.

**Asset format (path segments / `base` / `counter`):** `CURRENCY` for XRP, or
`CURRENCY+ISSUER` (also `CURRENCY.ISSUER`) for IOUs. Examples: `XRP`, `USD+rIssuer...`.

> **Pair canonicalization.** The service stores each pair in a single canonical orientation.
> If you request the inverse orientation, results are transparently **inverted**: trade
> `rate` and candle `open`/`close`/`high`/`low` and volumes are flipped so the response is
> expressed in the orientation you asked for.

#### `GET /v2/exchanges` — List all DEX trades

Common params only. Returns the `exchanges` list envelope.

```bash
curl -s 'https://api.gatehub.net/data-api/v2/exchanges?limit=1&descending=true' \
  -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "marker": "WyIyMDI0LTAxLTAxIDAwOjAwOjAwIiw4MDAwMDAwMCw3XQ",
  "count": 1,
  "exchanges": [
    {
      "base_currency": "XRP",
      "base_issuer": "",
      "base_amount": 100,
      "counter_currency": "USD",
      "counter_issuer": "rIssuer...",
      "counter_amount": 55.2,
      "rate": 0.552,
      "buyer": "rBuyer...",
      "seller": "rSeller...",
      "taker": "rTaker...",
      "provider": "rProvider...",
      "sequence": 12345,
      "date": "2024-01-01T00:00:00.000Z",
      "tx_type": "OfferCreate",
      "tx_index": 7,
      "ledger_index": 80000000,
      "tx_hash": "9C8D...AB"
    }
  ]
}
```

#### `GET /v2/exchanges/{base}/{counter}` — Trades or OHLC/VWAP candles for a pair

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `base` | path | string | yes | Base asset (`CURRENCY` or `CURRENCY+ISSUER`). |
| `counter` | path | string | yes | Counter asset. |
| `interval` | query | enum | no | If set, return **candles** for that interval; if omitted, return **raw trades**. |
| common | query | — | no | `start`, `end`, `limit`, `descending`, `marker`, `format`. |

**`interval` enum values:** `1minute`, `5minute`, `15minute`, `30minute`, `1hour`, `2hour`,
`4hour`, `1day`, `3day`, `7day`, `1month`.

**Raw trades** (no `interval`) return the `exchanges` list envelope (same fields as
`GET /v2/exchanges`, with `rate` inverted if you requested the non-canonical orientation).

**Candles** (`interval` set) return a bespoke shape (no `marker` — candles are bucketed, not
keyset-paged):

```bash
curl -s 'https://api.gatehub.net/data-api/v2/exchanges/XRP/USD+rIssuer...?interval=1hour&limit=2' \
  -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "count": 2,
  "base": { "currency": "XRP", "issuer": "" },
  "counter": { "currency": "USD", "issuer": "rIssuer..." },
  "interval": "1hour",
  "exchanges": [
    {
      "start": "2024-01-01T00:00:00.000Z",
      "open": 0.55,
      "close": 0.56,
      "high": 0.57,
      "low": 0.54,
      "base_volume": 12000.0,
      "counter_volume": 6700.0,
      "vwap": 0.5583,
      "count": 87
    }
  ]
}
```

Candle fields: `start` (bucket start, ISO), `open`, `close`, `high`, `low`, `base_volume`,
`counter_volume`, `vwap` (volume-weighted average price = counter_volume / base_volume),
`count` (trades in the bucket).

#### `GET /v2/exchange_rates/{base}/{counter}` — Latest rate or period VWAP

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `base` | path | string | yes | Base asset. |
| `counter` | path | string | yes | Counter asset. |
| `start` | query | string (ISO) | no | If `start` and/or `end` are given, the rate is the **VWAP** over that window. |
| `end` | query | string (ISO) | no | Upper bound of the VWAP window. |

With no `start`/`end`, returns the **most recent** trade rate. The rate is inverted if you
request the non-canonical orientation. No match yields `rate: 0`.

```bash
curl -s 'https://api.gatehub.net/data-api/v2/exchange_rates/XRP/USD+rIssuer...' \
  -H 'X-API-Key: <key>'
```

```json
{ "result": "success", "rate": 0.552 }
```

#### `GET /v2/normalize` — Convert an amount between two assets

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `amount` | numeric string | no | `1` | Amount to convert. |
| `base` | string | no | — | Source asset (`CURRENCY` or `CURRENCY+ISSUER`). |
| `counter` | string | no | — | Target asset. |
| `date` | string (ISO) | no | latest | Rate as of this time (accepted; current implementation uses the latest rate when `base`/`counter` are set without a window). |

If `base` or `counter` is omitted, the conversion is an identity (`rate: 1`,
`converted == amount`).

```bash
curl -s 'https://api.gatehub.net/data-api/v2/normalize?amount=100&base=XRP&counter=USD+rIssuer...' \
  -H 'X-API-Key: <key>'
```

```json
{ "result": "success", "amount": 100, "rate": 0.552, "converted": 55.2 }
```

---

### Tag: network

Indexed (ClickHouse), backed by daily roll-up views.

#### `GET /v2/network/payment_volume` — Total payment volume for a currency

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `currency` | string | no | `XRP` | Currency to measure. |
| `issuer` | string | conditionally | — | **Required** for non-XRP currencies; **must not** be set for `XRP`. |
| `start` | string (ISO) | no | — | Lower day bound. |
| `end` | string (ISO) | no | — | Upper day bound. |

Returns **400** if `issuer` is missing for a non-XRP currency, or set for `XRP`.

```bash
curl -s 'https://api.gatehub.net/data-api/v2/network/payment_volume?currency=USD&issuer=rIssuer...' \
  -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "data": { "currency": "USD", "issuer": "rIssuer...", "totalAmount": 12345678.9, "count": 4210 }
}
```

(For XRP the `issuer` field is omitted from `data`.)

#### `GET /v2/network/exchange_volume` — Total DEX exchange volume for a base currency

Same params and response shape as `payment_volume`, measured against the base side of DEX
trades. `totalAmount` is the summed base volume; `count` is the trade count.

```bash
curl -s 'https://api.gatehub.net/data-api/v2/network/exchange_volume?currency=XRP' \
  -H 'X-API-Key: <key>'
```

#### `GET /v2/network/top_currencies` — Top issued currencies by trustline count

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `descending` | boolean | no | `true` | Sort by trustline count descending when `true`. |
| `limit` | integer | no | `100` | Max rows. |

```bash
curl -s 'https://api.gatehub.net/data-api/v2/network/top_currencies?limit=2' \
  -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "count": 2,
  "currencies": [
    { "issuer": "rIssuerA...", "currency": "USD", "trustlines": 152300, "totalBalance": 9876543.21 },
    { "issuer": "rIssuerB...", "currency": "EUR", "trustlines": 88210, "totalBalance": 5432109.0 }
  ]
}
```

---

### Tag: stats

Indexed (ClickHouse), backed by a daily summary view.

#### `GET /v2/stats` — Daily network activity counts

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `start` | string (ISO) | no | — | Lower day bound. |
| `end` | string (ISO) | no | — | Upper day bound. |
| `descending` | boolean | no | `false` | Newest day first when `true`. |

> `limit`/`marker` are accepted by the shared DTO but are not applied — this endpoint returns
> all matching days (not cursor-paged).

```bash
curl -s 'https://api.gatehub.net/data-api/v2/stats?start=2024-01-01T00:00:00Z' \
  -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "count": 2,
  "stats": [
    { "date": "2024-01-01", "payments": 152000, "exchanges": 98000, "accounts_created": 1200 },
    { "date": "2024-01-02", "payments": 148500, "exchanges": 101200, "accounts_created": 1150 }
  ]
}
```

---

### Tag: accounts

Mostly indexed (ClickHouse). Two sub-routes are **live** — they hit the XRPL node directly
and are short-TTL cached (default 10 s): `…/balances` and `…/orders`. All others are indexed.

#### `GET /v2/accounts` — List created accounts (indexed)

Common params only. Returns the `accounts` envelope.

```bash
curl -s 'https://api.gatehub.net/data-api/v2/accounts?limit=1' -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "marker": "WyIyMDI0LTAxLTAxIDAwOjAwOjAwIiw4MDAwMDAwMF0",
  "count": 1,
  "accounts": [
    {
      "account": "rNewAccount...",
      "parent": "rFunder...",
      "balance": "20000000",
      "date": "2024-01-01T00:00:00.000Z",
      "ledger_index": 80000000,
      "tx_index": 2,
      "tx_hash": "1A2B...CD"
    }
  ]
}
```

#### `GET /v2/accounts/{address}` — Account creation info (indexed)

| Param | In | Type | Required | Description |
|---|---|---|---|---|
| `address` | path | string | yes | Account address. |

Returns **404** (`account-not-found`) if the account was never seen being created.

```json
{ "result": "success", "account": { "account": "rAddr...", "parent": "rFunder...", "balance": "20000000", "date": "2024-01-01T00:00:00.000Z", "ledger_index": 80000000, "tx_index": 2, "tx_hash": "1A2B...CD" } }
```

#### `GET /v2/accounts/{address}/balance_changes` — Balance changes (indexed)

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `currency` | string | no | — | Filter by currency. |
| `counterparty` | string | no | — | Filter by counterparty address. |
| common | — | no | — | `start`, `end`, `limit`, `descending`, `marker`, `format`. |

```json
{
  "result": "success",
  "marker": "...",
  "count": 1,
  "balance_changes": [
    {
      "account": "rAddr...",
      "counterparty": "rIssuer...",
      "currency": "USD",
      "change": -10.5,
      "final_balance": 89.5,
      "type": "payment",
      "date": "2024-01-01T00:00:00.000Z",
      "ledger_index": 80000000,
      "tx_index": 4,
      "node_index": 0,
      "tx_hash": "AB12...EF"
    }
  ]
}
```

#### `GET /v2/accounts/{address}/payments` — Account payments (indexed)

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | string | no | `both` | One of `sent`, `received`, `both`. |
| `currency` | string | no | — | Filter by currency. |
| `issuer` | string | no | — | Filter by issuer. |
| `source_tag` | integer | no | — | Filter by source tag. |
| `destination_tag` | integer | no | — | Filter by destination tag. |
| common | — | no | — | `start`, `end`, `limit`, `descending`, `marker`, `format`. |

Returns the `payments` envelope (item fields: `ctid`, `tx_hash`, `source`, `destination`,
`currency`, `issuer`, `amount`, `delivered_amount`, `source_currency`, `fee`, `source_tag`,
`destination_tag`, `date`, `ledger_index`, `tx_index`).

```bash
curl -s 'https://api.gatehub.net/data-api/v2/accounts/rAddr.../payments?type=received&limit=50' \
  -H 'X-API-Key: <key>'
```

#### `GET /v2/accounts/{address}/transactions` — Transaction history (indexed)

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | string | no | — | XRPL transaction type. |
| `result` | string | no | — | Engine result. |
| `min_ledger` | integer | no | — | Inclusive lower ledger index. |
| `max_ledger` | integer | no | — | Inclusive upper ledger index. |
| common | — | no | — | `start`, `end`, `limit`, `descending`, `marker`, `format`. |

Returns the `transactions` envelope; each item: `hash`, `ledger_index`, `type`, `result`,
`date`, parsed `tx`.

#### `GET /v2/accounts/{address}/exchanges` — Account DEX trades (indexed)

Common params only. Matches trades where the account is `buyer`, `seller` or `taker`. Returns
the `exchanges` envelope (item fields: `base_currency`, `base_issuer`, `base_amount`,
`counter_currency`, `counter_issuer`, `counter_amount`, `rate`, `buyer`, `seller`, `taker`,
`provider`, `date`, `ledger_index`, `tx_index`, `tx_hash`).

#### `GET /v2/accounts/{address}/balances` — Live balances (**live XRPL**, cached)

Reads `account_info` + `account_lines` directly from the XRPL node. Short-TTL cached (default
10 s).

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `ledger` | string | no | `validated` | Ledger index or hash; defaults to the validated/current ledger. |
| `currency` | string | no | — | Filter to a single currency (`XRP` returns only the XRP balance). |

```bash
curl -s 'https://api.gatehub.net/data-api/v2/accounts/rAddr.../balances' -H 'X-API-Key: <key>'
```

```json
{
  "result": "success",
  "ledger_index": 80000123,
  "count": 2,
  "balances": [
    { "currency": "XRP", "value": "150.5" },
    { "currency": "USD", "counterparty": "rIssuer...", "value": "89.5" }
  ]
}
```

#### `GET /v2/accounts/{address}/orders` — Live open orders (**live XRPL**, cached)

Reads `account_offers` from the XRPL node. Short-TTL cached (default 10 s).

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `ledger` | string | no | `validated` | Ledger index or hash. |
| `limit` | integer | no | `200` | Max offers to request from the node. |

```json
{
  "result": "success",
  "count": 1,
  "orders": [
    {
      "specification": {
        "direction": "buy",
        "quantity": { "currency": "USD", "issuer": "rIssuer...", "value": "100" },
        "totalPrice": "181.16",
        "expirationTime": "2024-02-01T00:00:00.000Z"
      },
      "properties": { "maker": "rAddr...", "sequence": 42, "makerExchangeRate": "0.552" }
    }
  ]
}
```

(`passive` appears in `specification` only when the offer is passive; `expirationTime` only
when set.)

#### `GET /v2/accounts/{address}/stats/transactions` — Transaction-type counts (indexed)

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `start` | string (ISO) | no | — | Lower time bound. |
| `end` | string (ISO) | no | — | Upper time bound. |

Returns counts keyed by transaction type:

```json
{ "result": "success", "stats": { "Payment": 1200, "OfferCreate": 340, "TrustSet": 12 } }
```

#### `GET /v2/accounts/{address}/reports` — Per-day sent/received payment report (indexed)

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `start` | string (ISO) | no | — | Lower time bound. |
| `end` | string (ISO) | no | — | Upper time bound. |

Aggregated in the database (exact totals, not truncated).

```json
{
  "result": "success",
  "count": 1,
  "reports": [
    {
      "date": "2024-01-01",
      "sent": { "XRP": 500.0, "USD": 120.5 },
      "received": { "XRP": 300.0 },
      "payment_count": 18
    }
  ]
}
```

---

## 7. Operational endpoints

These are unversioned, unauthenticated, and served at the root.

#### `GET /liveliness/healthz` — Liveness probe

Terminus health check that pings ClickHouse. Returns `200` when healthy, `503` when the
ClickHouse check fails.

```bash
curl -s http://localhost:3001/liveliness/healthz
```

```json
{
  "status": "ok",
  "info": { "clickhouse": { "status": "up" } },
  "error": {},
  "details": { "clickhouse": { "status": "up" } }
}
```

#### `GET /metricz` — Prometheus metrics

Returns Prometheus exposition text (`Content-Type: text/plain; version=0.0.4`). `500` if
metric collection fails.

```bash
curl -s http://localhost:3001/metricz
```

#### `GET /internal/docs` — Swagger UI

Interactive API explorer (Swagger UI) for the live OpenAPI document.

#### `GET /internal/docs/json` — OpenAPI JSON

The raw OpenAPI 3 document (JSON) generated from the running service. Use this as the source
of truth for client codegen.

```bash
curl -s http://localhost:3001/internal/docs/json
```
