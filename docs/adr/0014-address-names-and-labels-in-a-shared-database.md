# ADR-0014: Address names and labels live in a shared database, written by hand

**Status:** Accepted. The first exception to [ADR-0009](0009-one-deployment-per-network.md) (a database per network). Adds fields to
`GET /v2/accounts/{address}` of the contract of [ADR-0010](0010-ripple-v2-wire-compatibility.md).

## Context
The operator of the API wants to name addresses ("GateHub", "Bitstamp") and to mark them with labels (`scam`, `spam`, `advisory`). One key
pair has the same address on every network, so whoever holds it controls it everywhere: an address that is a scam on the XRP Ledger is one on
Xahau too. Each network has its own database (ADR-0009), and the API has no admin side: one trust level, read-only.

## Decision
- **Account names and labels belong to the address** and live in one shared database (`shared`) on the ClickHouse server that holds the
  network databases. Both networks' apis read it. The **account network name** says what an address does on one network ("USD Issuer"), so it
  lives in that network's database.
- **Ops write them with SQL inserts** for now. An admin service with its own keys comes later and is not part of this decision.
- **The tables are append-only.** The newest row of a key wins, a removal is a row with `removed = 1`, and every row records who wrote it and
  when, so the history of the table is the audit trail.
- **Label keys are a ClickHouse `Enum`** (`scam`, `spam`, `advisory`), so a misspelt label fails the insert instead of creating a new one. A
  new label is a migration.
- **They are served inline on `/v2/accounts/{address}` only**: `account_name`, `account_network_name` and
  `account_labels` (`{ "<label>": { "description": …, "source"?: …, "url"?: … } }`), each left out when there is none. These are added
  fields; the Ripple shape is otherwise unchanged. The api caches the sets and reloads them every 60 seconds.

## Consequences
- Rejected: a copy per network database, because a label written twice drifts. Rejected: lookup endpoints of their own, because the
  readers want them on the account.
- A hand-written row shows within a minute, and so does a mistake. Nothing but the `Enum` checks a row.
- A global name shows on every network, even where the address does nothing. The per-network role belongs in the account network name.
- The shared database has its own migrations, and they must be run before an api that reads it.
