# MPTokens: design

Date: 2026-10-17. Status: proposed. This is family 3 of `2026-10-17-amendments-roadmap.md`, whose shared rules are binding.

## Scope (decided by the user: full support)

This covers XRPL multi-purpose tokens (amendments MPTokensV1, TokenEscrow and fixMPTDeliveredAmount):

- issuances and holders;
- MPT amounts in payments, balance changes and escrows (today they are skipped);
- MPT payment volume;
- per-issuance stats: supply, holders and transfers.

MPT trading on the DEX (MPTokensV2) is not enabled, so exchanges stay as they are (ruling R12). Xahau has no MPTs.

## How it looks on the ledger

The facts below must be confirmed by Task 1's `FINDINGS.md`.

**The issuance id.** `MPTokenIssuanceID` is 24 bytes, written as 48 hex characters: the issuance `Sequence` (4 bytes, big-endian) followed by the issuer's AccountID (20 bytes).

**`MPTokenIssuance` object fields:**
- `Issuer`, `Sequence`, `AssetScale`;
- `MaximumAmount`, `OutstandingAmount`, `LockedAmount`;
- `TransferFee`, `MPTokenMetadata` (hex);
- `Flags`: `lsfMPTLocked`, `lsfMPTCanLock`, `lsfMPTRequireAuth`, `lsfMPTCanEscrow`, `lsfMPTCanTrade`, `lsfMPTCanTransfer`, `lsfMPTCanClawback`.

**`MPToken` object fields** (one per holder):
- `Account`, `MPTokenIssuanceID`;
- `MPTAmount`, `LockedAmount`;
- `Flags`: `lsfMPTLocked`, `lsfMPTAuthorized`.

**Amounts.** An MPT amount in a transaction is `{mpt_issuance_id, value}`. `value` is an integer string in the smallest units; `AssetScale` gives the decimal places.

**Transactions:**
- `MPTokenIssuanceCreate`, `MPTokenIssuanceDestroy`;
- `MPTokenIssuanceSet` (lock or unlock, globally or per holder);
- `MPTokenAuthorize` (a holder opts in or out; an issuer authorizes a holder);
- `Payment` with an MPT `Amount`;
- `Clawback` with an MPT `Amount` and a `Holder`;
- `EscrowCreate`, `EscrowFinish` and `EscrowCancel` with MPT amounts (TokenEscrow), which move `LockedAmount`.

## Decisions

| Topic | Decision |
|---|---|
| **Asset representation** | An MPT is an asset with `currency` = the 48-hex issuance id and `issuer` = the issuer's address. This fits every existing `(currency, issuer)` column and key: payments, payments_by_currency, account payments, balance changes and volume components. A 48-hex currency is always an MPT; 3-character codes and 40-hex codes stay IOU currencies. |
| **Asset syntax in requests** | `parseAsset` accepts `<48hex>` (the issuer is implied by the id) and `<48hex>+<issuer>`. With an explicit issuer that doesn't match the id, it gives 400 `issuer does not match mpt issuance`. |
| **Amounts in responses** | On MPT amounts only, the objects keep `currency`/`issuer`/`value` and add `mpt_issuance_id`. `value` is the raw integer string from the ledger, not scaled; issuance objects carry `asset_scale`. |
| **Balance changes** | Holder rows come from `MPToken.MPTAmount` diffs: `currency` = the id, `counterparty` = the issuer. The issuer row comes from the `OutstandingAmount` diff, negated, as an IOU issuer's balance shows. Escrow typing (`escrow_*` fields, `change_type` escrow_create/finish/cancel) covers MPT `LockedAmount` moves. |
| **Payment volume** | MPT issuances may appear in the markets config `paymentCurrencies`. With no MPT DEX there is no native rate, so they contribute `amount` and `count` but no `converted_amount`. Per-issuance volume in issuance units is served by the stats route. |

## 1. Storage

**Ledger tables**

| Table | Partition | ORDER BY | Holds |
|---|---|---|---|
| `mpt_issuance_events` | P7 | `(mpt_issuance_id, ledger_index, tx_index)` | Create, set, destroy and authorize events from the issuance's point of view. Columns: `issuer`, `event`, `holder` (for per-holder set or authorize), `flags_after`, `asset_scale`, `maximum_amount`, `transfer_fee`, `metadata_hex`, `outstanding_after`, `locked_after`, `tx_hash` and `close_time`. |
| `mpt_holder_states` | P7 | `(mpt_issuance_id, holder, ledger_index, tx_index)` | One row per `MPToken` node touched. Columns: `amount_after`, `locked_after`, `flags_after` and `deleted`. |
| `account_mpt_states` | P7 | `(holder, ledger_index, tx_index, mpt_issuance_id)` | A narrow index of the above, for per-account holdings. |

**MPT amounts in existing ledger tables.** `payments`, `payments_by_currency`, `account_payments` and `balance_changes` store MPT amounts with the representation above. This needs no schema change: `currency` is `LowCardinality(String)`, which holds a 48-hex value.

**Aggregate tables**

| Table | ORDER BY | Holds |
|---|---|---|
| `mpt_issuances` | `mpt_issuance_id` | The current state of each issuance: `issuer`, `sequence`, `asset_scale`, `maximum_amount`, `outstanding_amount`, `locked_amount`, `transfer_fee`, `flags`, `metadata_hex`, `metadata` (decoded JSON when the hex is valid UTF-8 JSON, the XLS-89 shape), `holders`, `created_ledger`, `destroyed` and `version`. |
| `mpt_holders` | `(mpt_issuance_id, holder)` | The current state of each holder: `amount`, `locked`, `flags` and `version`. Rows are recomputed per touched (issuance, holder) pair, filled forward from `mpt_holder_states`. |
| `mpt_daily` | `(mpt_issuance_id, day)` | `transfers` (payment count), `volume` (sum of delivered amounts in units), `holders_end`, `outstanding_end`, `minted` (issuer to holder), `burned` (holder to issuer), `clawed_back`, `config_version` and `version`. |

## 2. Parsing

- **Payments.** `payment.parser.ts` accepts MPT `Amount`, `SendMax`, `DeliverMax`, `DeliverMin` and `delivered_amount`, and emits them in the representation above. It no longer skips MPT payments. A mint is a payment from the issuer; a burn is a payment to the issuer. Both are ordinary payments, as on the ledger.
- **Balance changes.** `balance-changes.parser.ts` adds holder rows from `MPToken` diffs and issuer rows from `MPTokenIssuance.OutstandingAmount` diffs. `change_type` follows the existing mapping:
  - `Payment` is a payment;
  - an escrow transaction uses the escrow types;
  - `Clawback` is `clawback`, a new `change_type` that the reference never had.

  Escrow fields are filled for MPT escrows. `LockedAmount` moves are reported as escrow changes, not as balance changes of the holder's spendable amount, matching how XRP escrows are typed today.
- **A new `mpt.parser.ts`** emits issuance events and holder state rows.
- **Invariants checked in tests.** Per transaction and issuance, the sum of holder `MPTAmount` deltas plus the issuer's `OutstandingAmount` delta equals −(clawed-back amount) or 0. Locked amounts are conserved between holders and the issuance.

## 3. API

| Route | Params | Response |
|---|---|---|
| `GET /v2/mpt/issuances` | `issuer`, `include_destroyed`, `sort=holders\|outstanding\|created` (default `holders`), `limit`, `marker`, `format` | `{result, count, marker?, issuances:[Issuance]}` |
| `GET /v2/mpt/issuances/:id` | — | `{result, issuance}`; 404 `issuance not found`; 400 `invalid mpt issuance id` |
| `GET /v2/mpt/issuances/:id/holders` | `min_amount`, `include_zero`, `limit`, `marker`, `format` | `{result, count, marker?, holders:[{holder, amount, locked, authorized, frozen}]}`, ordered by amount desc then holder |
| `GET /v2/mpt/issuances/:id/history` | `start`, `end`, `event`, `holder`, `descending`, `limit`, `marker`, `format` | issuance events |
| `GET /v2/mpt/issuances/:id/stats` | `start`, `end`, `descending`, `limit`, `marker`, `format` | `days:[MptDay]` |
| `GET /v2/accounts/:address/mpt` | `issuer`, `include_zero`, `limit`, `marker`, `format` | the account's holdings, with issuance summary fields |

**Existing routes now carry MPT amounts.** `/v2/payments/:currency` with an MPT id lists MPT payments. `/v2/accounts/:a/payments` and `/v2/accounts/:a/balance_changes` include MPT rows, and their `currency` filter accepts an MPT id.

**Holder ordering.** Ordering holders by amount needs a key order other than the table's, so there is a second aggregate table, `mpt_holders_by_amount`, with `ORDER BY (mpt_issuance_id, version, neg_amount_f, holder)` (`neg_amount_f` = −scaled amount, so ascending order is largest first). The job writes each rebuild under a new version, then publishes that version in `mpt_issuances.holders_version`. Readers read only the published version, in key order, so paging stays bounded. Unpublished and superseded versions are deleted by the job once a newer version is published.

## 4. Aggregation

There are three jobs: `mpt_state` (issuances and holders, incremental from a watermark), `mpt_daily` (on a cadence) and the payment volume changes.

The holders-by-amount table is rewritten for the touched issuances only. It is written in chunks and capped by the job budget. An issuance with more than 100k holders is processed over several ticks, under one version that is published only when complete.

## 5. Testing

- **Fixtures** (Task 1):
  - issuance create, set (lock/unlock, global and per holder) and destroy;
  - a holder authorizing, an issuer authorizing and a holder opting out;
  - an MPT payment, a mint, a burn, and a payment with a transfer fee;
  - an MPT clawback;
  - an MPT escrow create/finish/cancel;
  - metadata in XLS-89 JSON and in non-JSON form.
- **Parser invariants** are those of §2, plus round-trip checks of the issuance id and decode/encode.
- The rest follows the shared pattern: ingest and recovery, API lists with EXPLAIN and `read_rows` bounds, aggregator version sets and budgets, and Xahau giving empty or 404 answers.

## 6. Out of scope

- An MPT DEX and MPT exchange rates (MPTokensV2 is not enabled).
- MPT price conversion into native.
