# Ledger features: oracles, identity, clawback, checks, token escrows, domains, tickets, batch: design

Date: 2026-10-17. Status: proposed. This is family 4 of `2026-10-17-amendments-roadmap.md`, whose shared rules are binding.

## Scope (decided by the user)

| Part | Amendments | Networks | What it gets |
|---|---|---|---|
| A. Price oracles | PriceOracle (+ fixPriceOracleOrder) | XRPL, Xahau | Price series per oracle and asset pair, a price-history route and daily aggregates |
| B. Identity objects | DID, Credentials, PermissionedDomains, PermissionDelegationV1_1 | XRPL | The current object and its change history per account |
| C. Clawback, checks, token escrows | Clawback, Checks (+ CheckCashMakesTrustLine), TokenEscrow (XRPL), PaychanAndEscrowForTokens (Xahau) | both | Clawback events, the check lifecycle, and IOU escrows and payment channels typed correctly in balance changes. MPT escrows are done in family 3. |
| D. Domains, tickets, batch | PermissionedDEX, TicketBatch, BatchV1_1 | XRPL (tickets: both) | The permissioned-DEX domain on exchanges (with a filter), ticket creation and use, and Batch outer/inner grouping |

Recorded fixtures already hold `OracleSet` (2), `CheckCreate`/`CheckCash` (1/31), `TicketCreate` (19), `Batch` (271, with inner transactions carrying `ParentBatchID` in their metadata) and escrows.

## 1. Storage

### The generic object-change table

Part B, tickets and checks share one append-only ledger table. Family 5 reuses it.

| Table | Partition | ORDER BY | Holds |
|---|---|---|---|
| `object_changes` | P7 | `(object_type, object_id, ledger_index, tx_index)` | One row per created, modified or deleted ledger object of a tracked type. Columns: `action`, `owner` (the object's primary account), `accounts` (`Array(String)`: every account the object names), `fields` (JSON text of the final or new fields, minus `PreviousTxnID`, `PreviousTxnLgrSeq` and the directory node pointers), `tx_hash`, `tx_type` and `close_time`. |
| `account_object_changes` | P7 | `(account, object_type, ledger_index, tx_index, object_id)` | A narrow index: one row per entry of `accounts`. |

The tracked types in this family are `DID`, `Credential`, `PermissionedDomain`, `Delegate`, `Check`, `Ticket` and `Oracle`. Tracking a type is a list in `packages/shared/src/parsers/object-changes.parser.ts`. A later family adds a type with one line.

### Part A: oracles

| Table | Kind | ORDER BY | Holds |
|---|---|---|---|
| `oracle_updates` | ledger, P7 | `(owner, document_id, ledger_index, tx_index, pair_index)` | One row per price-data entry per `OracleSet`, with `action` `set`, `remove_pair` (an entry without `AssetPrice`) or `delete` (`OracleDelete`). Columns: `base_asset`, `quote_asset`, `asset_price_raw` (the hex UInt64 as a decimal string), `scale`, `price` (exact decimal string = raw × 10^−scale), `price_f`, `last_update_time`, `provider`, `asset_class`, `uri`, `tx_hash` and `close_time`. |
| `oracle_prices_by_pair` | ledger, P7 | `(base_asset, quote_asset, ledger_index, tx_index, owner, document_id)` | A narrow index of the `set` rows. |
| `oracles` | aggregate | `(owner, document_id)` | The current state: `provider`, `asset_class`, `uri`, `last_update_time`, `pairs` (`Array` of `{base, quote, price, scale}`), `deleted` and `version`. |
| `oracle_daily` | aggregate | `(base_asset, quote_asset, day)` | Per day: `open`, `high`, `low`, `close` and `mean`, all over every update; `median_close`, the median of each oracle's last price that day; `updates`, `oracles`, `config_version` and `version`. |

**Asset names.** `base_asset` and `quote_asset` are stored as the ledger gives them: a 3-character code or 40 hex characters. A 40-hex code that decodes to printable ASCII is also served as its text.

### Part C: clawback and checks

| Table | Kind | ORDER BY | Holds |
|---|---|---|---|
| `clawbacks` | ledger, P7 | `(issuer, ledger_index, tx_index)` | Columns: `holder`, `currency`, `amount_issuer` (the IOU issuer, or the MPT issuer for an MPT), `amount` (the actual clawed-back delta from balance changes), `requested` (the transaction `Amount`), `tx_hash` and `close_time`. |
| `account_clawbacks` | ledger, P7 | `(holder, ledger_index, tx_index)` | A narrow index. |
| `check_events` | ledger, P7 | `(check_id, ledger_index, tx_index)` | Columns: `event` (`create`, `cash`, `cancel`, `removed`), `sender`, `destination`, `send_max`, `delivered` (for a cash, from the balance changes or `DeliverMin`/`Amount`), `invoice_id`, `destination_tag`, `source_tag`, `expiration` and `tx_hash`. |

Per-account check lists use `account_object_changes` with `object_type = 'Check'`.

**Token escrows and payment channels.** These need no new table. `balance-changes.parser.ts` types IOU escrow and channel moves:

- **On XRPL**, escrow moves are typed `escrow_create`, `escrow_finish` and `escrow_cancel`, and the `escrow_*` fields are filled with the IOU amount. IOU escrows lock the amount in the escrow object; the trust line is not debited until finish. Task 1 confirms this on the ledger.
- **On Xahau**, payment-channel moves are typed `paychannel_fund` and `paychannel_payout`, and their fields are filled for IOU channels.

### Part D: domains, tickets and batch

- **Domains:** `exchanges` and `account_exchanges` gain `domain_id String`, empty when there is none. It is the `DomainID` of the transaction (an `OfferCreate` or `Payment`) whose crossing produced the trade.
- **Tickets** are tracked in `object_changes`. A deleted `Ticket` is consumed by the deleting transaction, which carries `TicketSequence`.
- **Batch:**

  | Table | Partition | ORDER BY | Holds |
  |---|---|---|---|
  | `batch_transactions` | P7 | `(outer_hash, inner_index)` | One row per inner transaction. Columns: `inner_hash`, `outer_account`, `inner_account`, `mode` (`all_or_nothing`, `only_one`, `until_failure`, `independent`, from the outer flags), `inner_result`, `ledger_index` and `tx_index` (the inner transaction's), and `outer_tx_index`. |
  | `batch_by_inner` | P7 | `(inner_hash)` | `outer_hash` and `inner_index`. |

  These rows are built in a per-ledger pass in `buildLedgerRows`. Inner transactions carry `ParentBatchID` in their metadata, and the order comes from the outer transaction's `RawTransactions`. An inner transaction whose outer transaction is not in the same ledger is recorded with `inner_index = 65535` and counted. Task 1 checks whether that can happen.

## 2. Parsing

There are four new pure parsers:

- `object-changes.parser.ts` handles the tracked types: every affected node of a tracked `LedgerEntryType`.
- `oracle.parser.ts` reads `OracleSet` / `OracleDelete` together with the `Oracle` node diff. The resulting series is taken from the node's final `PriceDataSeries`.
- `clawback.parser.ts` and `check.parser.ts` emit the rows above.

Two existing parsers are extended:

- `exchanges.parser.ts` and the AMM swap rows get `domain_id`.
- `balance-changes.parser.ts` types IOU escrows and channels.

The batch pass runs in `build-rows.ts`. Every new parser has the same invariants and oracle-test requirements as the earlier families.

## 3. API

| Route | Params | Response |
|---|---|---|
| `GET /v2/oracles` | `provider`, `asset_class`, `base`, `quote`, `include_deleted`, `limit`, `marker`, `format` | `{result, count, marker?, oracles:[Oracle]}` |
| `GET /v2/oracles/:owner/:document_id` | — | `{result, oracle}`; 404 `oracle not found` |
| `GET /v2/oracles/:owner/:document_id/history` | `start`, `end`, `base`, `quote`, `descending`, `limit`, `marker`, `format` | `{result, count, marker?, updates:[OracleUpdate]}` |
| `GET /v2/oracle_prices/:base/:quote` | `start`, `end`, `interval` (unset = every update across oracles; `day` = `oracle_daily`), `owner`, `descending`, `limit`, `marker`, `format` | `{result, count, marker?, prices:[...] \| days:[...]}` |
| `GET /v2/accounts/:address/did` | `history` (default false) | `{result, did}` or `{result, count, marker?, history}`; 404 `did not found` |
| `GET /v2/accounts/:address/credentials` | `role=subject\|issuer` (default `subject`), `include_expired`, `include_unaccepted`, `limit`, `marker`, `format` | the current credentials |
| `GET /v2/credentials/:id` | `history` | the current credential and optionally its history |
| `GET /v2/domains/:id` | `history` | the current permissioned domain (owner, accepted credentials) and optionally its history |
| `GET /v2/accounts/:address/domains` | `limit`, `marker`, `format` | the domains the account owns |
| `GET /v2/accounts/:address/delegates` | `role=delegator\|delegate` (default `delegator`), `limit`, `marker`, `format` | the current delegations, with permissions |
| `GET /v2/accounts/:address/clawbacks` | `role=issuer\|holder`, `start`, `end`, `currency`, `descending`, `limit`, `marker`, `format` | clawback events |
| `GET /v2/checks/:id` | — | `{result, check: {current state, events}}`; 404 `check not found` |
| `GET /v2/accounts/:address/checks` | `role=sender\|destination`, `status=open\|cashed\|cancelled\|any` (default `open`), `limit`, `marker`, `format` | checks |
| `GET /v2/accounts/:address/tickets` | `status=open\|used\|any` (default `open`), `limit`, `marker`, `format` | `{result, count, marker?, tickets:[{ticket_sequence, created_ledger, created_tx, used_ledger?, used_tx?}]}` |
| `GET /v2/transactions/:hash/batch` | — | `{result, outer:{hash, account, mode, ledger_index}, inner:[{inner_index, hash, account, result}]}`; it works for either an outer or an inner hash; 404 `batch not found` |

**Exchange routes.** These gain a `domain` filter on the same routes as the AMM `amm` filter.

| `domain` value | Rows returned |
|---|---|
| `any` (default) | all rows |
| `none` | rows without a domain |
| `<64-hex id>` | rows in that domain |

An invalid value gives 400 `invalid domain filter`. The exchange object gains `domain_id`, as its last key after `amm_account`, only when it is set. Rates and volumes keep including all trades (as with AMM).

**Current state.** For the identity routes, checks and tickets it is read at query time: the latest `object_changes` row per object, in the object's or the account's partition. These sets are small, and per-account lists use `account_object_changes`. Oracle lists use the `oracles` aggregate.

## 4. Aggregation

There are two jobs:

- **`oracle_state`** runs every tick, from a watermark, and rebuilds `oracles`.
- **`oracle_daily`** runs on a cadence of every 5 ticks, with the finality and version-set rules.

Nothing else in this family needs an aggregate.

## 5. Testing

- **Fixtures** (Task 1):
  - `OracleSet` create, update, remove-pair and delete, on XRPL and Xahau;
  - `DIDSet` and `DIDDelete`;
  - credential create, accept, delete and expired;
  - a `PermissionedDomainSet` with accepted credentials, and a delete;
  - `DelegateSet`;
  - an IOU clawback, an MPT clawback reference, and a Xahau clawback;
  - check create, cash (exact and with `DeliverMin`), cancel and expired removal;
  - an IOU escrow create/finish/cancel (XRPL), and a Xahau IOU payment channel create, fund and claim;
  - a domain offer, a domain payment and a hybrid offer;
  - a ticket create and a ticket use;
  - Batch in each mode, including a failing inner transaction.

  `FINDINGS.md` confirms:
  - IOU escrow trust-line behaviour;
  - the domain trade attribution rule;
  - whether inner Batch transactions always sit in the same ledger as their outer transaction.
- **Parser golden tests** per part, with an oracle reimplementation, plus these invariants:
  - an oracle price equals raw × 10^−scale exactly;
  - clawback `amount` equals the holder's balance-change delta;
  - batch inner counts equal `RawTransactions`.
- **The rest** follows the shared pattern.

## 6. Out of scope

- Live `get_aggregate_price`.
- Credential verification beyond the ledger fields.
- Delegate permission semantics beyond listing them.
