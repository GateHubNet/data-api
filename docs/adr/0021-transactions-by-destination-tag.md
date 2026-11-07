# ADR-0021: Transactions by destination tag: a ledger table keyed by destination and tag

**Status:** Accepted (2026-11-06). Amends [ADR-0010](0010-ripple-v2-wire-compatibility.md#amendment-12-2026-11-06-transactions-by-destination-tag) (Amendment 12, items 118 to 121). Applies
[ADR-0007](0007-ledger-index-axis-and-secondary-tables.md)'s narrow secondary tables to one more key, and [ADR-0016](0016-nft-and-uritoken-data.md)'s coverage rule (`FeatureCoverageService`) to one
more feature. The design is in [the destination tag spec](../superpowers/specs/2026-11-06-destination-tag-transactions-design.md).

## Context
A deposit address, such as an exchange's, tells its senders apart by destination tag: one lookup should give everything sent to that
wallet under one tag, however many transactions the wallet has. `account_transactions` is sorted by account and ledger, so a filter on
the tag would read the wallet's whole history.

## Decision
1. **A ledger table keyed `(account, destination_tag, ledger_index, tx_index)`** (`account_tx_by_destination_tag`, migration 018): one row per
   tagged transaction, `account` the destination, with the transaction's type, result and close time. It is ledger-keyed, so a reprocess
   replaces its rows with the rest of the block, and P7, the 10-million partitions of `account_transactions`. The syncer refuses to boot its
   `ingest` worker without it.
2. **The rule reads the fields, from parser version 11** (`DESTINATION_TAG_PARSER_VERSION`). A transaction gets a row when its own `Destination`
   is a string and its own `DestinationTag` an integer from 0 to 4,294,967,295, of any type and any result, Batch inner transactions included.
   Anything else gives no row, and nothing throws. No list of types: a type added later with both fields is covered without a code change.
3. **The page fetches the transactions as the time list does.** `GET /v2/accounts/{address}/transactions?destination_tag=T` pages through the
   table by its key, with the window as a ledger range, `type` and `result`, then reads the transactions by key exactly as the list without
   the tag does. The marker is the time list's `(ledger_index, tx_index)`.
4. **The coverage feature `destination_tags`**, starting at the network's first ledger (`first_ledger`), as `issued_tokens` does. `coverage`
   is the key after `result` and is not in the CSV.
5. **Two 400s:** `invalid destination_tag` for anything but digits from 0 to 4294967295, and `destination_tag cannot be combined with
   min_sequence or max_sequence`, checked with the sequences and before the dates.
6. **Set aside** (spec §4): a `destination_tag` column with a skip index on `account_transactions`, because a busy wallet has many tags in every
   granule, so the index rarely skips; and filtering the stored transaction JSON at query time, which reads the whole history the same way.

## Consequences
- **One row per tagged transaction:** the schema goes from 85 tables to 86, and a tagged page reads its own rows and two granules a part.
- **`complete` only after the whole-history reprocess.** Parser version 11 writes the rows from its deploy on; the program's reprocess of the
  whole history fills the older ledgers, and until then `coverage` says `complete: false` and older ledgers have no rows ([backfill](../backfill.md#destination-tag-re-ingest)).
- **Testnets are never complete:** their index has no first ledger.
- **A finishing transaction is not listed under the tag of what it finishes.** `EscrowFinish`, `CheckCash` and `PaymentChannelClaim` carry no
  tag of their own: the tagged create is listed, and the object's own route shows how it ended.
