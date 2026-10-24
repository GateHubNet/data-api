# Ledger objects and delegation (D5): design

Date: 2026-10-24. Status: proposed (2026-10-24), program 2, sub-project D5. Repository `GateHubNet/data-api`, branch
`feat/explorer-data-2` (stacked on PR #20, `feat/account-investigation-data`).

- Boards (approved, in `x-explorer/docs/superpowers/specs/2026-10-24-explorer-mock/`): `Escrow.dc.html` (states pending, can be
  finished, can be cancelled, finished, cancelled), `Check.dc.html` (open, cashed, cancelled, expired), `PayChannel.dc.html` (open,
  closing, closed), `Delegation.dc.html` (the account tab "Permissions given / held", a transaction "sent by X on behalf of Y", a
  `DelegateSet`), `Account.dc.html` (the Objects tab's "Open escrow →"), `Transaction.dc.html`.
- Related specs: `2026-10-17-ledger-features-design.md` (the generic `object_changes` table, `check_events`, Delegate objects and the
  token-escrow notes: this spec builds the subset named below and does not edit it), `2026-10-17-amendments-roadmap.md` (shared rules),
  ADR-0015 (state from history), and the explorer's side, `x-explorer/docs/superpowers/specs/2026-10-24-ledger-object-pages-design.md`
  (E10). D7 (`2026-10-24-supply-design.md`) reads the escrowed total this spec keeps (section 4.3).

## Owner decisions to confirm

| # | Choice | Recommendation |
|---|---|---|
| 1 | One generic ledger table, `object_changes` (the ledger-features table), holds the history of `Escrow`, `Check`, `PayChannel` and `Delegate`. Its `check_events` table is folded into `object_changes.event` / `event_fields` (escrows and channels need the same per-transaction facts), and its `accounts` array becomes `owner` + `counterparty`, with a `role` in the account index. | Accept |
| 2 | An object's state and history are read **at query time** from `object_changes` (exact, no aggregator lag). The only aggregate is `escrows`, kept for D7's escrowed total. | Accept |
| 3 | An escrow named by owner and sequence (as `EscrowFinish` names it) is resolved by computing its ledger object ID (no table): `GET /v2/accounts/{address}/escrows/{sequence}`, beside `/transactions/{sequence}`. The list `/v2/accounts/{address}/escrows` stays 404 (ADR-0010 item 7). | Accept |
| 4 | The API serves a time-derived `status` (`pending`, `can_be_finished`, `can_be_cancelled`, `expired`, `closing`, …), evaluated at the close time of the newest indexed ledger, which every answer names. | Accept |
| 5 | A detail answer embeds the **newest 50** events of the object; older events are paged through `/history`. Escrows and checks have at most a few events; a busy payment channel has thousands. | Accept |
| 6 | A payment channel whose `CancelAfter` or `Expiration` has passed but which is still in the ledger is `closing` (any transaction on it closes it). The board has no separate state for it. | Accept |
| 7 | The API has **no node fallback**: an object the index has no row of answers 404, and the explorer asks the node (`ledger_entry`). | Accept |
| 8 | The `Delegate` field is indexed by listing the delegate under its own account in `account_transactions` (always, even when its account root is not in the metadata), not by a new column or filter. The account-transactions CSV gains a last column `delegate`, and its `fee` moves to the row of the account that paid it. | Accept |
| 9 | **Bug fix:** today a delegated transaction's fee row in `balance_changes` (`transaction_cost`) is put on `Account` although the delegate paid it. It moves to the delegate. Needs a re-ingest from the delegation amendment (row 13). | Accept |
| 10 | On Xahau (no delegation) `/v2/accounts/{address}/delegations` answers an empty list with `complete: true`, not 404. Escrows, checks and channels are served on both networks. | Accept |
| 11 | The route is `/v2/accounts/{address}/delegations?direction=given\|held` (the brief), not the ledger-features spec's `/delegates?role=delegator\|delegate`. Rows keep the ledger's names `account` and `authorize`. | Accept |
| 12 | `GET /v2/ledger_objects/{id}`, a type lookup of any tracked object, so the explorer's search can send a pasted object ID to its page. | Accept |
| 13 | Rollout re-ingests (`--reprocess`) from 107,524,865 (PermissionDelegationV1_1) to the deploy ledger: delegation is then complete. Escrows, checks and channels stay incomplete (their `coverage` says so) until the history backfill reaches 28,685,313; no extra backfill in D5. | Accept |
| 14 | Coverage is D3's `FeatureCoverageService` (D3 §4), with four features keyed by `OBJECT_PARSER_VERSION` and the amendments Escrow, PayChan, Checks and PermissionDelegationV1_1; one object's history is complete when the feature's is or when its creation is indexed (D3's per-NFT rule). Xahau's amendments file gains the genesis ledger for Escrow, PayChan and Checks, as D3 does for URIToken. | Accept |
| 15 | Issued-token payment channels (Xahau, `PaychanAndEscrowForTokens`) are typed in `balance_changes` with token amounts; today `channel()` reads every amount as drops. | Accept |
| 16 | **Consistency pass:** D5 defines the MPT amount object of the data API's answers (section 5.1); D9, built later, serves MPT amounts in this shape and adds the scale and ticker through its `?ids=` batch, without changing it. | Accept: D5 serves MPT escrow amounts before D9 exists. |

## Context

What exists on this branch:

- **No object tables.** The original's escrows and paychannels tables and routes were dropped (ADR-0010 items 7 and 10); escrow and
  channel moves are only *typed* in `balance_changes` (`escrow_create`, `escrow_finish`, `escrow_cancel`, `paychannel_fund`,
  `paychannel_payout`, by `BalanceChangesParser.escrow()` / `.channel()`). The ledger-features spec (proposed, not built) designed a
  generic `object_changes` table, `check_events` and Delegate routes; none exists in code.
- **State from history** (ADR-0015): `account_states` and `trust_line_states` record the final fields of every changed node; the state at L
  is the newest row at or before L; coverage is "above the newest ledger an older parser wrote" (`StateLedgerService`). This spec applies
  the same approach to ledger objects.
- **Delegation is live on XRPL**: PermissionDelegationV1_1 was enabled at ledger 107,524,865 (2026-10-08) and BatchV1_1 at 107,540,993.
  Delegated transactions are already ingested: their `tx_json` carries `Delegate`, but `BalanceChangesParser.accountRoot()` charges the fee
  to `tx.Account`, which is wrong for them (decision 9).
- **The explorer** shows an account's live objects from the node (`account_objects`) and has no object page.

## Goal

Serve, on both networks, the state and history of every escrow, check and payment channel by its ledger object ID, including objects that
no longer exist; serve an account's delegations (given and held); index the `Delegate` field; and keep the escrowed native total cheap for
D7.

## Scope

- Ingest: `object_changes` and `account_object_changes` (ledger tables) for `Escrow`, `Check`, `PayChannel`, `Delegate`; the delegate in
  the affected accounts; the fee row of a delegated transaction on the delegate; token amounts in channel typing.
- Aggregate: `escrows` (current state per escrow, and a total sentinel).
- Routes: `/v2/escrows/{id}[/history]`, `/v2/accounts/{address}/escrows/{sequence}`, `/v2/checks/{id}[/history]`,
  `/v2/payment_channels/{id}[/history]`, `/v2/accounts/{address}/delegations`, `/v2/ledger_objects/{id}`; the `delegate` column of the
  account-transactions CSV.

## Non-goals

- The network-wide escrows list, escrow release forecasts (deferred by the owner), and per-account object lists
  (`/v2/accounts/{address}/{escrows,payment_channels,checks}` stay 404; the explorer's Objects tab reads the node).
- The rest of the ledger-features family (oracles, DID, credentials, domains, tickets, batch, clawback): a later family adds its types to
  `TRACKED_OBJECT_TYPES` with one line each and keeps this table.
- MPT balance-change rows and MPT escrow typing (D9). D5 serves MPT *amounts* of token escrows in object answers only.
- Live state from the node in the API (decision 7), and permission semantics beyond listing them.

## Facts this design relies on

| Fact | Source |
|---|---|
| Enablement on XRPL: Escrow and PayChan 28,685,313; Checks 56,219,905; TokenEscrow 102,204,929; PermissionDelegationV1_1 107,524,865 | `packages/shared/config/amendments/xrpl.json` |
| Xahau: Escrow and PayChan retired (always on), Checks and PaychanAndEscrowForTokens on from genesis; no delegation | `config/amendments/xahau.json`, definitions |
| An escrow's ID is SHA-512Half(`0x0075` ‖ owner AccountID ‖ UInt32 sequence), the sequence being the creating `EscrowCreate`'s `Sequence`, or its `TicketSequence` when a ticket was used | xrpl.org, Escrow entry |
| Escrow fields: `Account, Destination, Amount` (XRP, or an issued token or an MPT with TokenEscrow), `FinishAfter?, CancelAfter?, Condition?, SourceTag?, DestinationTag?, TransferRate?, IssuerNode?, Sequence?` | definitions `LEDGER_ENTRY_FORMATS` |
| Check fields: `Account, Destination, SendMax, Sequence, Expiration?, InvoiceID?, SourceTag?, DestinationTag?`; PayChannel: `Account, Destination, Amount, Balance, PublicKey, SettleDelay, Expiration?, CancelAfter?, SourceTag?, DestinationTag?, Sequence?` | the same |
| Delegate fields: `Account, Authorize, Permissions` (1 to 10 `{Permission: {PermissionValue}}`); `DelegateSet` with an empty list deletes the entry; the delegate signs and **pays the fee**, the transaction uses `Account`'s sequence | xrpl.org (DelegateSet, permission delegation) |
| `PermissionValue`: a transaction type's code + 1, or a granular permission from 65537 (`TrustlineAuthorize`) to 65548 (`MPTokenIssuanceUnlock`); the node writes the name when it knows it, else the number | xrpl.org, Permission Values |
| Metadata: a created node has `NewFields` (non-default fields), a modified one `FinalFields` (all fields) and `PreviousFields` (what changed), a deleted one `FinalFields` (all fields) | rippled; already relied on by `account_states` |
| Xahau's `EscrowFinish` / `EscrowCancel` may name the escrow by `EscrowID` (Hash256) | `config/definitions/xahau.json` |

## 1. Data model

One new migration (the next number; the plan assigns it) with three `CREATE TABLE IF NOT EXISTS`. Additive: it reads no other table.
Required before the syncer of this release (its writer inserts into the two ledger tables on every ledger) and before the api.

### 1.1 `object_changes` (ledger table, P7)

One row per created, modified or deleted node of a tracked type in a transaction's metadata: the object's state after the transaction,
what changed, and the event it was.

```sql
CREATE TABLE IF NOT EXISTS object_changes
(
  object_type   LowCardinality(String),
  object_id     String,
  ledger_index  UInt32,
  tx_index      UInt32,
  tx_hash       String,
  close_time    DateTime('UTC'),
  tx_type       LowCardinality(String),
  result        LowCardinality(String),
  sender        String,
  delegate      String,
  action        Enum8('created' = 1, 'modified' = 2, 'deleted' = 3),
  event         LowCardinality(String),
  owner         String,
  counterparty  String,
  fields        String CODEC(ZSTD(3)),
  previous      String CODEC(ZSTD(3)),
  event_fields  String
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (object_type, object_id, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;
```

| Column | Content |
|---|---|
| `object_type` | `Escrow`, `Check`, `PayChannel`, `Delegate` (the `LedgerEntryType`) |
| `object_id` | The node's `LedgerIndex`, 64 hex digits, upper case |
| `sender`, `delegate` | The transaction's `Account` (`senderAccount`), and its `Delegate` or `''` |
| `event` | Per type, section 2.2 |
| `owner`, `counterparty` | The object's `Account`; its `Destination` (`Escrow`, `Check`, `PayChannel`) or `Authorize` (`Delegate`) |
| `fields` | JSON of the node's fields after the transaction (`NewFields` of a created node, else `FinalFields`), keys sorted, raw ledger values (drops as text, issued-token and MPT amount objects, Ripple-epoch times), without `PreviousTxnID`, `PreviousTxnLgrSeq`, `OwnerNode`, `DestinationNode`, `IssuerNode` |
| `previous` | JSON of `PreviousFields` (keys sorted, same exclusions), `'{}'` when the node has none |
| `event_fields` | JSON of the facts the event takes from the transaction (section 2.2), keys sorted, `'{}'` when none |

The key is unique: a transaction has one node per object. A row is written whatever the transaction's result (a `tec` can delete an
expired channel; its metadata says so), and `result` keeps it. A modified node without `PreviousFields` was only threaded and has no row,
as in `account_states`. It is a child table like the others: in `CHILD_TABLES`, in `LEDGER_KEYED_TABLES` with P7, with the dedup window,
deleted by recovery and `--reprocess`.

### 1.2 `account_object_changes` (ledger table, P7)

The narrow index of `object_changes` by account: one row for the owner and one for the counterparty of each row (two rows when they are
the same account, one per role).

```sql
CREATE TABLE IF NOT EXISTS account_object_changes
(
  account       String,
  object_type   LowCardinality(String),
  role          Enum8('owner' = 1, 'counterparty' = 2),
  ledger_index  UInt32,
  tx_index      UInt32,
  object_id     String,
  action        Enum8('created' = 1, 'modified' = 2, 'deleted' = 3)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, object_type, role, ledger_index, tx_index, object_id)
SETTINGS non_replicated_deduplication_window = 1000;
```

`role` is in the key so that "delegations given" (`owner`) and "held" (`counterparty`) are each a prefix. D5 reads it for `Delegate` only;
it is written for every tracked type so that the later per-account lists of the ledger-features family need no re-ingest.

### 1.3 `escrows` (aggregate, no partition)

The current state of every escrow the index has seen, rebuilt by the aggregator (section 4), plus one **sentinel** row that holds the
escrowed total.

```sql
CREATE TABLE IF NOT EXISTS escrows
(
  escrow_id       String,
  owner           String,
  destination     String,
  sequence        Nullable(UInt32),
  currency        LowCardinality(String),
  issuer          String,
  amount          String,
  amount_drops    UInt64,
  finish_after    Nullable(DateTime('UTC')),
  cancel_after    Nullable(DateTime('UTC')),
  has_condition   UInt8,
  created_ledger  Nullable(UInt32),
  last_ledger     UInt32,
  deleted         UInt8,
  open_count      UInt64,
  through_ledger  UInt32,
  version         UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY escrow_id;
```

- An escrow row: `currency` is `XRP`/`XAH` with `issuer = ''` for the native currency, the 3-letter or 40-hex code for an issued token, the
  48-hex issuance ID for an MPT (with its issuer); `amount` in whole units (an MPT's raw integer units); `amount_drops` the drops of a native
  escrow, 0 for a token; `last_ledger` the ledger of its newest `object_changes` row; `deleted` 1 once finished, cancelled or removed;
  `open_count` and `through_ledger` 0.
- **The sentinel** (`escrow_id = ''`): `open_count` = escrows with `deleted = 0`, `amount_drops` = the sum of their native drops,
  `through_ledger` = the ledger the job has processed up to (its watermark); the other columns empty or 0.
- Readers take the newest version per key without `FINAL`: `ORDER BY escrow_id, version DESC LIMIT 1 BY escrow_id`, then filter
  `deleted`; the sentinel is `WHERE escrow_id = '' ORDER BY version DESC LIMIT 1`.

### 1.4 Parser version and coverage

A new parser version (the plan numbers it) writes the two ledger tables and the changes of section 2.3. Its constant is
`OBJECT_PARSER_VERSION` in `rows.ts` (beside `STATE_PARSER_VERSION`, the per-feature gate pattern of D3's `NFT_PARSER_VERSION`), and
readers gate on it, never on `PARSER_VERSION`.

**Coverage** is D3's: `FeatureCoverageService.coverage(feature)` (D3 §4, `apps/api/src/common/feature-coverage.service.ts`), which D5
does not redefine. `from_ledger_index` is one above the newest stored ledger a parser older than the feature's version wrote (or the oldest
stored ledger), `complete` is `from_ledger_index <= E`, E the amendment's enable ledger as `/v2/network/amendments/{name}` reports it (the
amendments data, never a constant; on a testnet only an indexed `EnableAmendment`), kept 60 s. D5 registers four features, all on
`OBJECT_PARSER_VERSION` (the ledgers below are what the amendments data holds today, not constants of the code):

| Feature | Amendment | XRPL E | Xahau E |
|---|---|---|---|
| `escrows` | Escrow | 28,685,313 | genesis (retired) |
| `payment_channels` | PayChan | 28,685,313 | genesis (retired) |
| `checks` | Checks | 56,219,905 | genesis |
| `delegations` | PermissionDelegationV1_1 | 107,524,865 | none: a feature the network cannot have (D3 §4, see 5.6) |

Xahau's `config/amendments/xahau.json` gains the genesis ledger as `enabled.ledger_index` of Escrow, PayChan and Checks (read from the node
in Task 1), as D3's decision 18 does for URIToken; without it D3's rule answers `complete: false`. **Per object** (detail and history),
D3's per-NFT rule: `complete` is true when the feature's is, or when the object's creation is indexed (its `created` ledger is at or above
`from_ledger_index`). The shape is D3's, right after `result`: `"coverage": { "from_ledger_index": 107524865, "complete": false }`.

## 2. Parsing

### 2.1 `ObjectChangesParser` (`packages/shared/src/parsers/object-changes.parser.ts`)

```ts
export const TRACKED_OBJECT_TYPES = ['Escrow', 'Check', 'PayChannel', 'Delegate'] as const;
export interface ParsedObjectChange {
  object_type: string; object_id: string; action: 'created' | 'modified' | 'deleted'; event: string;
  owner: string; counterparty: string;
  fields: string; previous: string; event_fields: string;   // sorted-key JSON (stableStringify)
}
export class ObjectChangesParser { parse(t: ParserTx, ctx: ParseContext): ParsedObjectChange[]; }
```

Pure and synchronous, deep-frozen input, every node of a tracked type in `AffectedNodes` order. `buildLedgerRows` adds the ledger and
transaction columns (`ledger_index`, `tx_index`, `tx_hash`, `close_time`, `tx_type`, `result`, `sender`, `delegate`) and writes
`objectChanges` and `accountObjectChanges` (`LedgerRows`, `CHILD_TABLES`).

### 2.2 Events

The event is decided from the transaction type, the action and the fields, in this order; anything else is `update` (a modification by an
unexpected type) and is counted in `diagnostics.objectsUnclassified` (`syncer_objects_unclassified_total`).

| Type | Event | When | `event_fields` |
|---|---|---|---|
| Escrow | `create` | created by `EscrowCreate` | `sequence`: the transaction's `Sequence`, or its `TicketSequence` when `Sequence` is 0 |
| | `finish` | deleted by `EscrowFinish` | `fulfillment` (the transaction's `Fulfillment`, when it has one) |
| | `cancel` | deleted by `EscrowCancel` | |
| | `removed` | deleted by any other type | |
| Check | `create` | created by `CheckCreate` | `sequence` (as above) |
| | `cash` | deleted by `CheckCash` | `delivered`: the metadata's `DeliveredAmount`, else the transaction's `Amount` (a cash for an exact amount delivers it or fails). Never `DeliverMin` (ledger-features Review Focus 3) |
| | `cancel` | deleted by `CheckCancel` | |
| | `removed` | deleted by any other type | |
| PayChannel | `create` | created by `PaymentChannelCreate` | `sequence` (as above) |
| | `close` | deleted by `PaymentChannelClaim` or `PaymentChannelFund` (a close, or a transaction on an expired channel) | |
| | `removed` | deleted by any other type | |
| | `fund` | modified by `PaymentChannelFund` | |
| | `close_request` | modified by `PaymentChannelClaim` with `tfClose`, `Expiration` in the final fields | |
| | `renew` | modified by `PaymentChannelClaim` with `tfRenew`, `Expiration` in the previous fields and not in the final ones | |
| | `claim` | any other modification by `PaymentChannelClaim` | |
| Delegate | `set` | created or modified by `DelegateSet` | |
| | `delete` | deleted by `DelegateSet` (an empty `Permissions`) | |
| | `removed` | deleted by any other type (an `AccountDelete`; Task 1 confirms which deletes it) | |

Edge cases the tests pin: an escrow created with a ticket (sequence = `TicketSequence`); a token escrow (`Amount` an issued-token object or
`{mpt_issuance_id, value}`, `TransferRate`); a check cashed with `DeliverMin` (delivered < `SendMax`); a check cancelled by a third party
after its expiration; a channel funded with a new `Expiration`; a claim by the source with `tfClose` that closes at once (balance equals
amount: `close`) and one that sets `Expiration` (`close_request`); a claim on an expired channel (`close`, which a `tec` can carry); a
`DelegateSet` that replaces a list and one that empties it; a Batch inner transaction (its own metadata, its own rows); Xahau's
`EscrowFinish` with `EscrowID`.

**Invariants** (golden tests over the recorded fixtures): an `Escrow` created row's `object_id` equals `escrowId(owner,
event_fields.sequence)`; a `cash` row's `delivered` equals the destination's balance-change delta in that currency; a channel row's
`Balance` minus `previous.Balance` equals the destination's `paychannel_payout` change; `fields` round-trips (`JSON.parse`) and has sorted
keys; untracked types give no rows.

### 2.3 Changes to existing parsers

- **`BalanceChangesParser.accountRoot()`**: the fee payer is `tx.Delegate` when the transaction has one, else `tx.Account`
  (`feePayer(tx)`, exported from `parser.interface.ts`). The `transaction_cost` row (node −1) is the payer's, and the payer's other row is
  its change less the fee; `Account`'s row is its whole change. The existing invariant "per currency, changes sum to zero but the fee
  burn" now holds for delegated transactions (today it holds only by accident of the sum).
- **`BalanceChangesParser.channel()`**: `Amount` and `Balance` go through `escrowValue` (drops converted, a token as it is), so issued-token
  channels on Xahau are typed with token amounts instead of `dropsToNative` of an object (ledger-features, token escrows and channels).
  `escrow()` already reads token amounts; Task 1's `FINDINGS.md` confirms that an issued-token escrow on XRPL moves the sender's trust line at
  create and the destination's at finish, and the typing follows the ledger (the issuer's mirrored row stays untyped).
- **`AffectedAccountsParser`**: appends `tx.Delegate` when the metadata does not already name it, so the delegate always has its
  `account_transactions` row (`is_initiator = 0`), even for a fee-free Batch inner transaction. That is the index of the `Delegate` field
  (decision 8); `account_tx_by_sequence` stays the sender's only.

### 2.4 Shared helpers

- `escrowId(owner, sequence)` and `ledgerObjectSpace` in `packages/shared/src/util/keylets.ts`: SHA-512Half over the space key, the
  decoded AccountID and the big-endian UInt32 (`ripple-address-codec`'s `decodeAccountID`, Node's `crypto`).
- `permissionOf(value, definitions)` in `packages/shared/src/parsers/permissions.ts`: a `PermissionValue` (name or number) as
  `{ permission, kind, transaction_type? }`. `GRANULAR_PERMISSIONS` is a hand-kept table of the 12 granular permissions (name, value,
  transaction type), as the definitions do not carry them; a transaction-level value is a `TRANSACTION_TYPES` code + 1 of the network's
  definitions; anything else is `kind: "unknown"` with the number as `permission`.

## 3. Reading an object (query time)

`LedgerObjectsService` (`apps/api/src/ledger-objects/ledger-objects.service.ts`). Every read is capped at the newest committed ledger
`H` (the `ledgers` commit marker, through `LedgerRangeResolver.latest()`), whose index and close time `T` the answer carries.

1. **Page of rows**: `readDistinctPage` over `object_changes` with `object_type = {type} AND object_id = {id} AND ledger_index <= {H}`,
   `ORDER BY ledger_index DESC, tx_index DESC`, deduped by `(ledger_index, tx_index)`, `limit` 51 (the detail's 50 and one to know there
   are more). No rows: 404.
2. **State**: the newest row's `fields`; removed when its `action` is `deleted`.
3. **Creation**: the row with `action = 'created'` when it is in the page, else one prefix read `... AND action = 'created' LIMIT 1`
   (a payment channel older than its newest 50 events).
4. **Counts** (payment channels only): `SELECT event, count() FROM (… LIMIT 1 BY ledger_index, tx_index) GROUP BY event` over the
   object's prefix, for `funds` and `claims`.

`object-views.ts` maps a row's JSON to the response objects (key order pinned by tests); `object-status.ts` holds the status rules of
section 5.2, which E10 mirrors for objects it reads from the node.

## 4. The `escrows` aggregate

### 4.1 The job

`recomputeEscrows(ch, ids, opts)` and `escrowsTouchedIn(ch, fromLedger, toLedger)` in `packages/shared/src/aggregate/escrows.job.ts`;
the runner `apps/syncer/src/aggregator/escrows.job-runner.ts` (the `AggregatorJobContext` pattern), job `escrows`, every tick, after
`amm_pools`, budget `AGGREGATOR_ESCROWS_BUDGET_MS = 2000`.

1. **Watermark** `W` = the sentinel's `through_ledger` (0 without one); `H` = the newest committed ledger.
2. **Touched escrows**: `SELECT DISTINCT object_id FROM object_changes WHERE object_type = 'Escrow' AND ledger_index > {W} AND
   ledger_index <= {U}`, `U = min(H, W + ESCROWS_STEP_LEDGERS)` (`ESCROWS_STEP_LEDGERS = 1,000,000`, so a first run over all history
   proceeds in steps within the budget). P7 partition pruning and the `object_type` prefix bound it to the escrow rows of the partitions
   that hold `(W, U]`.
3. **Recompute** each touched ID, `ESCROWS_CHUNK = 500` at a time: its newest row at or before `U` (`LIMIT 1 BY object_id`) and its created
   row, mapped to an `escrows` row and inserted under a new version (the larger of the ClickHouse clock in ms and the newest version + 1).
   An ID with no row left (a re-ingest removed them) gets a lightweight `DELETE` of its rows (Ruling R-A28's rule for `amm_pools`).
4. **Total**, when anything changed: `SELECT count(), sum(amount_drops) FROM (SELECT deleted, amount_drops, currency, issuer FROM escrows
   WHERE escrow_id != '' ORDER BY escrow_id, version DESC LIMIT 1 BY escrow_id) WHERE deleted = 0 AND issuer = '' AND currency = {native}`.
5. **Commit**: the sentinel (`through_ledger = U`, the total: the new one, or the previous one when nothing changed) is written **last**,
   under a newer version, **on every run, whether or not an escrow changed**, so that its watermark follows the head (D7 takes its
   supply snapshot's ledger from it). It is the run's commit marker, as `ledgers` is the ingest's: a run that fails before it leaves the
   old sentinel (its total and watermark agree with each other) and the next run does `(W, U]` again, which rewrites the same rows.

**Re-ingests.** Each `agg_dirty` slice (`hooksOfSlice`, syncer 7.6, a hook after `account_rollups` and D3's `nft_state`) recomputes the escrows touched in
the slice's ledgers plus those whose `last_ledger` falls in them (an escrow whose rows vanished), then rewrites the sentinel with the same
`through_ledger`. A failure fails the slice (`escrows_dirty`), as the other hooks.

**Gauges**: `syncer_escrows_lag_ledgers` (`H − through_ledger`), `syncer_escrows_open` (the sentinel's count).

### 4.2 Cost

The total reads one narrow row per escrow ever seen (XRPL: a few hundred thousand), only on a run that changed something: tens of
milliseconds. Should it grow past a few million rows, the total can be kept incrementally (the old row out, the new row in), with the
sentinel still written last; the readers do not change.

### 4.3 What D7 reads

`readEscrowed(ch)` in `packages/shared/src/aggregate/escrows.job.ts`, which D7's `supply` job calls in the syncer:

```ts
export interface Escrowed { drops: string; open: number; through_ledger: number }
```

One read of the sentinel (`WHERE escrow_id = '' ORDER BY version DESC LIMIT 1`). Its coverage is not in it (the coverage service is the
api's): D7's api asks `FeatureCoverageService.coverage('escrows')` (section 1.4) for its escrowed part. Escrows created before the
coverage start that are still open are missing until the history backfill: D7 shows `complete: false` until then.

## 5. Endpoints

`apps/api/src/ledger-objects/` (`ledger-objects.module.ts` in `ENDPOINT_MODULES`; `escrows.controller.ts`, `checks.controller.ts`,
`payment-channels.controller.ts`, `ledger-objects.controller.ts`, `ledger-objects.service.ts`, `object-views.ts`, `object-status.ts`),
and in `apps/api/src/accounts/`: `account-escrow.controller.ts` (owner + sequence), `account-delegations.controller.ts`,
`delegations.service.ts`. GateHub extras: none has a Ripple original.

### 5.1 Common rules

- **Coverage and as of**: every answer starts `result, coverage, ledger_index, close_time`: D3's coverage of its feature (per object on a
  detail or history, section 1.4), then the newest committed ledger and its close time (`YYYY-MM-DDTHH:mm:ssZ`), the point the state and
  `status` are evaluated at. `ledger_objects/{id}` has none of the three. Coverage is not in the CSV (D3).
- **IDs**: 64 hex digits in either case, answered in upper case. **Times** (`finish_after`, `cancel_after`, `expiration`, event `time`) are
  ISO UTC, converted from the Ripple epoch. **Amounts** are objects `{ currency, issuer?, value }`: the native currency's code without an
  issuer and the value in whole units (drops converted); an issued token as on the ledger; an MPT as `{ currency: <issuance ID>, issuer,
  value: <raw integer units>, mpt_issuance_id }` (the 48 upper-case hex digits of the issuance ID in `currency` and again as the last key
  `mpt_issuance_id`, the issuer read from the ID, the value never scaled). **This is the data API's MPT amount object**: D5 defines it
  because it serves MPT escrows first; D9 serves every MPT amount in this shape and adds the scale and the ticker through `GET
  /v2/mpt?ids=`, never in the amount. Absent fields are left out; `null` is never used.
- **History** is the transactions that changed the object (a failed attempt that touched nothing is not in it). An event:
  `event, ledger_index, time, tx_hash, tx_type, account, delegate?, result`, then the type's fields (5.3–5.5). `account` is the sender.
- **Detail answers** embed `history` newest first, at most 50, and `history_marker` when there are more; it continues
  `/{id}/history?descending=true&marker=…` (markers work for one route and direction).
- **History routes**: `descending` (default false, oldest first), `limit` (200, max 1000), `marker` (`(ledger_index, tx_index)`), `Link`,
  `format=csv`. Answer `{ result, coverage, ledger_index, close_time, count, marker?, history }`.
- **Caching**: the global `Cache-Control` (`private, max-age=60`).

### 5.2 Status rules (`object-status.ts`)

`T` is the answer's `close_time` (rippled tests a transaction against its parent ledger's close time, which is `T` for the next ledger).

| Type | Status |
|---|---|
| Escrow, in the ledger | `can_be_cancelled` if `cancel_after` and `T > cancel_after`; else `pending` if `finish_after` and `T <= finish_after`; else `can_be_finished` (a conditional escrow without `finish_after` can be finished from its creation) |
| Escrow, deleted | `finished`, `cancelled` or `removed`, from the deleting event |
| Check, in the ledger | `expired` if `expiration` and `T >= expiration`, else `open` |
| Check, deleted | `cashed`, `cancelled`, `removed` |
| PayChannel, in the ledger | `closing` if `expiration` is set, or `cancel_after` and `T >= cancel_after`; else `open` |
| PayChannel, deleted | `closed` (event `close`) or `removed` |

### 5.3 `GET /v2/escrows/{id}`

```json
{ "result": "success", "coverage": { "from_ledger_index": 107524865, "complete": true },
  "ledger_index": 107721455, "close_time": "2026-10-24T09:30:00Z",
  "escrow": {
    "escrow_id": "5B9C0E6A…D21F", "account": "rJF2XanJQGFLS5ZUdcqEzwJcTJ7aFfQvg", "sequence": 46118302,
    "destination": "rCpf…7Kq2", "amount": { "currency": "XRP", "value": "1000" },
    "finish_after": "2026-12-01T00:00:00Z", "cancel_after": "2027-01-01T00:00:00Z",
    "condition": "A0258020…810120", "destination_tag": 30418, "status": "pending",
    "created": { "ledger_index": 107684512, "time": "2026-10-15T08:44:19Z", "tx_hash": "3C1E…" } },
  "history": [
    { "event": "create", "ledger_index": 107684512, "time": "2026-10-15T08:44:19Z", "tx_hash": "3C1E…", "tx_type": "EscrowCreate",
      "account": "rJF2XanJQGFLS5ZUdcqEzwJcTJ7aFfQvg", "result": "tesSUCCESS", "amount": { "currency": "XRP", "value": "1000" } } ] }
```

**Escrow**, in this order: `escrow_id, account, sequence?, destination, amount, finish_after?, cancel_after?, condition?, fulfillment?,
destination_tag?, source_tag?, transfer_rate?, status, created?, removed?`. `account` is the owner; `sequence` is the object's `Sequence`,
else the creating event's; `fulfillment` is the finishing transaction's (a finished conditional escrow); `transfer_rate` is the ledger's
UInt32 (a token escrow); `created` is `{ledger_index, time, tx_hash}` when the creation is indexed; `removed` is `{ledger_index, time,
tx_hash, tx_type}` once deleted. Events add `amount` (create) and `fulfillment` (finish).

Errors: 400 `invalid escrow id`; 404 `escrow not found`; 500 `unable to retrieve escrow`. `/history`: the same, `invalid marker`, 500
`unable to retrieve escrow history`, CSV file `<id> - escrow history.csv`.

**`GET /v2/accounts/{address}/escrows/{sequence}`** answers exactly as `/v2/escrows/{escrowId(address, sequence)}`. 400 `invalid ripple
address`, `invalid sequence number` (the messages of `/transactions/{sequence}`); 404 `escrow not found`; 500 `unable to retrieve escrow`.

### 5.4 `GET /v2/checks/{id}`

`{ result, coverage, ledger_index, close_time, check, history, history_marker? }`. **Check**: `check_id, account, sequence?, destination,
send_max, expiration?, invoice_id?, destination_tag?, source_tag?, delivered?, status, created?, removed?` (`delivered` once cashed). Events
add `send_max` and `expiration?` (create) and `delivered` (cash).

```json
{ "check_id": "84A1…", "account": "rP4Y…", "sequence": 991203, "destination": "rL0w…",
  "send_max": { "currency": "4E50555344000000000000000000000000000000", "issuer": "rNPk…", "value": "2500" },
  "expiration": "2026-11-30T12:00:00Z", "invoice_id": "6F2A…", "destination_tag": 88231, "delivered":
  { "currency": "4E50555344000000000000000000000000000000", "issuer": "rNPk…", "value": "2180.4" },
  "status": "cashed", "created": { … }, "removed": { "ledger_index": 107731020, "time": "2026-10-27T09:15:02Z", "tx_hash": "…",
  "tx_type": "CheckCash" } }
```

Errors: 400 `invalid check id`; 404 `check not found`; 500 `unable to retrieve check` / `unable to retrieve check history`; CSV
`<id> - check history.csv`.

### 5.5 `GET /v2/payment_channels/{id}`

`{ result, coverage, ledger_index, close_time, payment_channel, history, history_marker? }`. **Payment channel**: `channel_id, account,
sequence?, destination, amount, balance, remaining, settle_delay, public_key, expiration?, cancel_after?, destination_tag?, source_tag?,
status, opened_with?, funds, claims, created?, removed?`. `amount` is what was deposited in all, `balance` what was paid out, `remaining`
their difference (left, or returned to the source once closed); `settle_delay` in seconds; `opened_with` the deposit of the creating
transaction (when indexed); `funds` and `claims` count the `fund` events and the events that raised `balance`. Events add `amount` and
`balance` (after the transaction), `amount_change?` and `balance_change?` (when not zero, from `previous`), `expiration?` (after) and
`settle_delay` (create).

Errors: 400 `invalid channel id`; 404 `payment channel not found`; 500 `unable to retrieve payment channel` / `unable to retrieve payment
channel history`; CSV `<id> - payment channel history.csv`.

### 5.6 `GET /v2/accounts/{address}/delegations`

| Parameter | Default | Meaning |
|---|---|---|
| `direction` | `given` | `given`: the delegations the account gave (it is the `Account`); `held`: those it holds (it is the `Authorize`) |
| `limit` | 200 (max 1000) | |
| `marker` | | |
| `format` | json | `csv`: file `<address> - delegations given.csv` / `… held.csv`; `permissions` is one cell, names separated by a space |

```json
{ "result": "success", "coverage": { "from_ledger_index": 107524865, "complete": true },
  "ledger_index": 107721455, "close_time": "2026-10-24T09:30:00Z", "count": 1,
  "delegations": [ { "delegation_id": "C07D…", "account": "rNPk…", "authorize": "rHbL…",
    "permissions": [ { "permission": "Payment", "kind": "transaction" },
                     { "permission": "TrustlineAuthorize", "kind": "granular", "transaction_type": "TrustSet" } ],
    "updated": { "ledger_index": 107690822, "time": "2026-10-14T16:03:22Z", "tx_hash": "9D40…" },
    "created": { "ledger_index": 107601140, "time": "2026-10-10T11:20:05Z", "tx_hash": "51EE…" } } ] }
```

Only delegations in the ledger at `H` are listed. Order: `updated` newest first, then `delegation_id`; the marker holds the last row's
`(ledger_index, tx_index, delegation_id)`. Read (section 6): the account's prefix of `account_object_changes` for (`Delegate`, role) gives
the IDs, at most `DELEGATION_IDS_CAP = 10,000` (more answers 500 and logs: a guard, not a page), then their newest `object_changes` rows;
the deleted ones are dropped and the rest sorted and paged in memory. On a network without delegation (`NetworkProfile.hasDelegation`,
new: `true` on XRPL and XRPL Testnet, `false` on Xahau and Xahau Testnet) the answer is the empty list, without a read of the tables,
and its `coverage` is D3's rule for a feature the network cannot have: the service's `from_ledger_index` with `complete: true` (there is
nothing to miss). Errors: 400 `invalid ripple address`, `invalid direction`, `invalid marker`; 500 `unable to retrieve delegations`.

### 5.7 `GET /v2/ledger_objects/{id}`

`{ result, ledger_object: { object_id, object_type, account, deleted, ledger_index } }` from the newest row of any tracked type (one read
with `object_type IN (TRACKED_OBJECT_TYPES)`): `account` is the owner, `ledger_index` the row's ledger. 400 `invalid ledger object id`;
404 `ledger object not found`; 500 `unable to retrieve ledger object`.

### 5.8 Changes to existing routes

- **`/v2/accounts/{address}/transactions?format=csv`**: the summary row gains `delegate` as its **last** column (the transaction's
  `Delegate`, empty when none), and `fee` is on the row of the account that paid it (`feePayer(tx)`), not on the sender's when a delegate
  paid. The JSON list is unchanged (its `tx` already carries `Delegate`), and so are the PDF columns.
- **`/v2/accounts/{address}/balance_changes`** and everything derived from `balance_changes` (`stats/value`, `reports`, the analytics, the
  rollups): a delegated transaction's `transaction_cost` row is the delegate's (section 2.3), from the re-ingest on.

## 6. Query bounds

`apps/api/test/paged-reads.e2e-spec.ts` (over a bulk of four parts) and plan tests (`expectBoundedInOrderRead`) pin:

| Read | Bound |
|---|---|
| Detail page of rows, history page | the key prefix `(object_type, object_id)` and `ledger_index <= H` in the plan; `read_rows` ≤ one granule per partition spanned plus the page |
| Creation and counts (channels) | the object's prefix only; `read_rows` ≤ the object's rows + a granule per partition |
| Owner + sequence | as the detail (the ID is computed before any read) |
| Delegations | `account_object_changes` by `(account, 'Delegate', role)` prefix, then `object_changes` by the listed IDs (`object_id IN`, `object_type = 'Delegate'`); `read_rows` ≤ the account's delegation rows + a granule per ID and partition |
| `ledger_objects/{id}` | `object_type IN (4 values) AND object_id = {id}`: a granule per type and partition |
| `escrows` job, touched IDs | P7 partition pruning on `ledger_index` and the `object_type = 'Escrow'` prefix; `read_rows` ≤ the escrow rows of the partitions holding `(W, U]` |
| `readEscrowed` | one row (the sentinel prefix) |

## 7. XRPL and Xahau

| | XRPL | Xahau |
|---|---|---|
| Escrows | XRP; issued tokens and MPTs with TokenEscrow (102,204,929) | XAH; issued tokens (PaychanAndEscrowForTokens); `EscrowFinish` may carry `EscrowID` (the parser reads nodes, so nothing changes) |
| Checks, payment channels | yes | yes (issued-token channels with PaychanAndEscrowForTokens) |
| Delegation | from 107,524,865 | none: empty list, `complete: true`; `NetworkProfile.hasDelegation` (new, `false`) skips the read |
| Coverage (D3 §4) | E from the amendments table of 1.4 | E = genesis, added to `xahau.json` (1.4) |

Hooks may emit escrow, check and channel transactions on Xahau; they are rows like any other (the sender is the emitting account).

## 8. Backfill, reprocess and rollout

1. Apply the migration before the syncer and the api of this release (the writer fails without the tables; the api's routes read them).
2. Deploy the syncer and the api. From the deploy ledger every ledger has object rows and the fixed fee rows.
3. **Delegation**: `range-ingest --from 107524865 --to <deploy ledger> --reprocess` on XRPL (about 200,000 ledgers, hours on Ripple's
   full-history node). It writes the `Delegate` rows, the delegates' `account_transactions` rows and the corrected fee rows; `agg_dirty`
   carries the rewrite into the rollups. Coverage then starts at 107,524,865: delegation `complete: true`.
4. **Escrows, checks, channels**: `complete` stays `false` until the history backfill writes every ledger from 28,685,313 (XRPL) or from
   genesis (Xahau) with this parser or a later one. An object untouched since the coverage start is 404 here and shown from the node by
   E10. Not part of D5.
5. The `escrows` job builds its table from the rows there are on its first runs (steps of 1,000,000 ledgers), and again through `agg_dirty`
   after each reprocess. `syncer_escrows_lag_ledgers` reaches a few ledgers when it has caught up.

`docs/backfill.md` gets "Ledger objects and delegation re-ingest" with the commands, the coverage query
(`SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < <OBJECT_PARSER_VERSION>`) and step 3.

## 9. Interfaces with other sub-projects

- **E10** reads every route of section 5 (its spec lists the calls), shows `coverage`, mirrors section 5.2 for node-read objects, and uses
  `ledger_objects/{id}` in search.
- **D7** calls `readEscrowed` (4.3) and takes its snapshot ledger from the sentinel's watermark, written on every run (4.1); it does
  not read `object_changes`.
- **D9** owns MPT balance changes and escrow typing; D5 defines the MPT amount object (5.1), which D9 adopts for every MPT amount it
  serves and extends only through its `?ids=` batch (scale, ticker).
- **Later ledger-features families** add types to `TRACKED_OBJECT_TYPES` and events to 2.2, and their routes read the same tables.

## 10. Documentation to update

- `docs/api-reference.md`: a section "Ledger objects" (5.1–5.5, 5.7, the status rules) and, under Accounts, `/escrows/{sequence}` and
  `/delegations`; the CSV row of account transactions (`delegate`, `fee`); the fee row of a delegated transaction under balance changes;
  the "Compatibility" list of extras.
- ADR-0010: a new amendment section (the next number at build time) with items for the new routes, the CSV `delegate` column and `fee`
  rule, the delegated fee row in `balance_changes` (a fix), and item 7 kept (the account escrow and channel lists still 404).
- A new ADR (the next number): "Ledger object history in one generic table, read at query time": the table, the events, why no
  current-state aggregate but `escrows`, D3's coverage applied per object type.
- `docs/data-model.md` (the three tables, the table count, the migration row, the relationships diagram), `docs/syncer.md` (the parser,
  the `escrows` job and its `agg_dirty` hook, the gauges), `docs/backfill.md` (section 8), `docs/operations.md` (the gauges and the
  re-ingest), `docs/openapi.yaml`, `rows.ts`' parser-version comment.

## 11. Testing

- **Fixtures** (Task 1, `record:fixtures --txs`, at most two requests in flight, into `packages/shared/test/fixtures/{xrpl,xahau}/objects/`
  with `manifest.json` and `FINDINGS.md`). XRPL: `EscrowCreate` timed with both times, conditional, and with a ticket; `EscrowFinish` timed
  and with a fulfillment; `EscrowCancel`; an issued-token escrow create and finish, and an MPT escrow create if one exists; `CheckCreate` (XRP;
  an issued token with `InvoiceID` and `Expiration`); `CheckCash` with `Amount` and with `DeliverMin` (the recorded 107,671,568 is one case); `CheckCancel`
  by the source and by a third party after expiry; `PaymentChannelCreate`, `PaymentChannelFund` (with `Expiration`), `PaymentChannelClaim` as
  claim, close request, close by the destination, renew and close of an expired channel; `DelegateSet` create, replace and empty; a
  delegated `Payment` and a delegated `tec`; a delegated Batch inner transaction if one exists. Xahau: `EscrowCreate`, `EscrowFinish` (with
  `EscrowID` if found), `EscrowCancel`, `CheckCreate`, `CheckCash`, `PaymentChannelCreate`, `PaymentChannelClaim`, an issued-token escrow and an issued-token
  channel. `FINDINGS.md` confirms: `DeliveredAmount` on XRP and issued-token cashes; the issued-token escrow trust-line behaviour; which transactions delete a
  `Delegate`; Xahau's escrow fields; Xahau's genesis ledger (for `xahau.json`, 1.4).
- **Unit**: parser golden tests and the invariants of 2.2 with an oracle reimplementation, deep-frozen input, at least 10 mutants killed;
  the fee-payer change (every existing snapshot unchanged for non-delegated transactions); `escrowId` against every recorded `EscrowCreate`;
  `permissionOf` (names, numbers, unknown); `object-views` key order per type; `object-status` truth table; the CSV summary row with and
  without a delegate.
- **e2e** (testcontainers, seeded through `LedgerWriter`): `apps/api/test/ledger-objects.e2e-spec.ts` (each type open and removed, history
  paging both ways and concatenation, the embedded page and its marker, the owner + sequence route, `ledger_objects`, every error message,
  401 without a key, coverage incomplete and complete), `delegations.e2e-spec.ts` (given, held, replaced, emptied, paging, CSV, Xahau
  empty), `account-transactions` CSV additions, `ledger-writer.e2e-spec.ts` and `range-ingest.e2e-spec.ts` (new tables written, recovered,
  reprocessed), `migrate.e2e-spec.ts` (keys and partitions), the `escrows` job (`escrows.job.e2e-spec.ts`: watermark steps, total equals a
  full recount, a re-ingest that removes an escrow, idempotence, one insert per run), and the bounds of section 6.
