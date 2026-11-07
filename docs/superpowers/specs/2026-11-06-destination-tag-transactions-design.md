# Transactions by destination tag: design

Status: approved by the owner, 2026-11-06. It builds on `feat/explorer-data-2` ([#21](https://github.com/GateHubNet/data-api/pull/21)): migration 017 and parser version 10 must be there first.

## 1. Goal

List every transaction sent to an account with a given destination tag: `GET /v2/accounts/{A}/transactions?destination_tag=T`. The use is a wallet that tells its senders apart by tag, such as an exchange's deposit address: one lookup gives everything sent to that wallet under one tag, quickly, however many transactions the wallet has.

## 2. Scope

**In:** every transaction whose own `Destination` is A and whose own `DestinationTag` is T, of any type and any result, on the XRP Ledger and Xahau. Tag 0 is a tag like any other, not "no tag".

**Out:**
- **Transactions that finish a tagged object.** `EscrowFinish`, `CheckCash` and `PaymentChannelClaim` carry no tag of their own; the tag is on the escrow, check or channel they finish (owner, 2026-11-06). The tagged `EscrowCreate`, `CheckCreate` or `PaymentChannelCreate` is listed, and the object's own route shows how it ended.
- **Transactions A sent with a tag.** A must be the destination.
- **Source tags**, and a list of the tags an account has received.

## 3. Which transactions carry the fields

From the protocol definitions the nodes enforce (`include/xrpl/protocol/detail/transactions.macro` of rippled `master` and `develop`, and of xahaud `dev`, read 2026-11-06):

| Network | Types with `DestinationTag` |
| --- | --- |
| XRP Ledger | `Payment`, `EscrowCreate`, `CheckCreate`, `PaymentChannelCreate`, `AccountDelete`, `VaultWithdraw`, `LoanBrokerCoverWithdraw`, `ConfidentialMPTSend` |
| Xahau | `Payment`, `EscrowCreate`, `CheckCreate`, `PaymentChannelCreate`, `AccountDelete`, `XChainClaim`, `Remit`, `Invoke` |

The parser reads the two fields, not a list of types, so a type added later with both fields is covered without a code change.

## 4. Storage

Migration `018_destination_tags.sql`, one table per network database:

```sql
CREATE TABLE IF NOT EXISTS account_tx_by_destination_tag
(
  account         String,
  destination_tag UInt32,
  ledger_index    UInt32,
  tx_index        UInt32,
  tx_type         LowCardinality(String),
  result          LowCardinality(String),
  close_time      DateTime('UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, destination_tag, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;
```

- **One row per tagged transaction.** `account` is the destination.
- **The sort key starts with the account and the tag,** so a lookup reads only that tag's rows. A `destination_tag` column on `account_transactions` was considered and set aside: that table is sorted by account and ledger, a busy wallet has many tags in every granule, so a skip index rarely skips and a lookup would read the wallet's whole history. Filtering stored transaction JSON on the fly was set aside for the same reason.
- **Ledger-keyed:** the table joins `LEDGER_KEYED_TABLES` with the 10-million partition size of `account_transactions`, so a reprocess replaces its rows with the rest of the block.
- **Schema check:** the syncer refuses to boot its ingest without the table, as for 017.
- **Counts:** the schema goes from 85 tables to 86.

## 5. Ingest

- **Version:** `PARSER_VERSION` 10 → 11, with `DESTINATION_TAG_PARSER_VERSION = 11`.
- **The rule:** `buildLedgerRows` writes a row for every transaction of the ledger whose `Destination` is a string and whose `DestinationTag` is an integer from 0 to 4,294,967,295. Every result counts, `tec` ones included. Batch inner transactions count like any other.
- **Malformed fields:** a transaction whose `DestinationTag` is anything else, or that has no `Destination`, gets no row. Nothing throws.
- **Values:** `account` = `Destination`, `destination_tag`, and the transaction's `ledger_index`, `tx_index`, `TransactionType`, `TransactionResult` and the ledger's close time, as `account_transactions` holds them.

## 6. The route

`GET /v2/accounts/{address}/transactions` gains one optional parameter, `destination_tag`.

- **Value:** digits only, from 0 to 4294967295. Anything else is `400 invalid destination_tag`. This differs from `/payments`, where text that is not a tag matches nothing, because that rule copies Ripple's; this parameter is ours, so it says what is wrong.
- **With sequences:** `destination_tag` with `min_sequence` or `max_sequence` is `400 destination_tag cannot be combined with min_sequence or max_sequence`, because those page through `account_tx_by_sequence`.
- **What it reads:** with the tag given, the route pages through `account_tx_by_destination_tag`. It filters on `account` and `destination_tag`, the time range as a ledger range, `type` and `result`. It orders by the table's key, ascending or with `descending`, with `limit` + 1 rows. Then it fetches the transactions by key exactly as the time list does.
- **Marker:** the time list's form, `(ledger_index, tx_index)`.
- **Answer:** the route's usual body and forms (`binary`, the summary form, `format=csv`), with `coverage` (`from_ledger_index`, `complete`) as the key right after `result`, as on the MPT and supply routes. The CSV has no `coverage`.
- **Coverage:** a new `COVERAGE_FEATURES` entry, `destination_tags`, with parser version 11 and `first_ledger` as its start on both networks. `complete` stays `false` until every ledger from the network's first has parser version 11 or later.
- **Without the tag:** the route's answer and reads are unchanged, byte for byte.

## 7. Bounds

A tagged page reads at most its own rows plus 2 granules per part of the new table, proved with a bulk fixture and a mutation that drops the tag from the key, in the form of `paged-reads.e2e-spec.ts`.

## 8. Docs

- **Reference:** the parameter, its rules and an example under the account transactions route, with `coverage`.
- **OpenAPI:** `docs/openapi.yaml` regenerated. The path count does not change.
- **ADRs:** ADR-0021, "Transactions by destination tag", and ADR-0010 Amendment 12, from item 118.
- **Operations:** `docs/backfill.md`, `docs/operations.md`, `docs/clickhouse.md` and the table counts.

## 9. Testing

- **Parser:** recorded ledgers of each type that has the fields, where recordings exist. Synthetic cases for tag 0, no tag, no `Destination`, a tag that is not an integer or is above 2^32 − 1, a failed transaction, a Batch inner transaction and Xahau's `Remit`.
> **Dated note (2026-11-06, the plan).** Recordings exist for a failed payment, a Batch inner payment, tag 0 and Xahau's `Remit`, so the plan uses them in place of synthetic cases. No recording has a tag on any other type, so those are synthetic edits of recorded untagged creates.

- **Ingest e2e:** the rows are written and replaced by a reprocess.
- **API e2e:**
    - the filter, with paging in both directions, `start` and `end`, `type`, `result`, `binary`, the summary form and the CSV
    - the two errors, tag 0, and an account that sent with a tag but received none
    - `coverage` incomplete and complete, and Xahau
    - the read bound
    - the answer without the tag unchanged

## 10. Rollout

1. Apply migration `018` on each network database.
2. Deploy the syncer (parser version 11) and the api together.
3. Reprocess. The planned whole-history reprocess covers this if it runs after parser version 11. Until then `coverage` says `complete: false`, and older ledgers have no rows.

## 11. Decisions

1. **Only transactions that carry the tag** (owner, 2026-11-06).
2. **A table keyed by destination and tag** (owner, 2026-11-06: approach 1 of 3).
3. **A bad tag is a 400**, not an empty list: proposed in the design, open to the owner's correction.
4. **`coverage` on a tagged answer:** proposed in the design, open to the owner's correction.
