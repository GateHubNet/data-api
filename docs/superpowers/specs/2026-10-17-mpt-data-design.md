# MPTokens: design (D9)

Date: 2026-10-17, revised 2026-10-24. Status: revised (2026-10-24), program 2, sub-project D9. Never built: the 2026-10-17 version
(family 3 of `2026-10-17-amendments-roadmap.md`, whose shared rules stay binding) is revised in place for the explorer's MPT pages.

- **Boards** (approved 2026-10-24, x-explorer `docs/superpowers/specs/2026-10-24-explorer-mock/`): `Mpt.dc.html` (one issuance),
  `Tokens.dc.html` with `kind=mpt` and `TokensMpt.dc.html` (the token list's MPT tab, on XRPL Testnet). Their sample data is made up.
- **The explorer's side:** x-explorer `docs/superpowers/specs/2026-10-24-mpt-page-design.md` (E14).
- **Related specs:** `2026-10-24-issued-tokens-design.md` (D6: `/v2/tokens`, which this spec extends with `kind=mpt`),
  `2026-10-24-display-names-design.md` (D4: `/v2/account_names`, which the explorer calls for every address shown here),
  `2026-10-24-testnet-profiles-design.md` (D-env: the testnet profiles and their amendment metadata),
  `2026-10-24-ledger-objects-delegation-design.md` (D5: the MPT amount object of §5.1, which this spec adopts, and MPT escrows),
  `2026-10-17-nft-data-design.md` (D3, revised: the shared `FeatureCoverageService` and the per-feature parser-version gate this spec
  uses), the plan `../plans/2026-10-17-mpt-data.md` (written for the 2026-10-17 version; it is rewritten from this spec).
- **Builds on** PR #20 (`feat/account-investigation-data`): the state-history pattern of `account_states` / `trust_line_states`
  (ADR-0015), the parser-version gates (`STATE_PARSER_VERSION`, `StateLedgerService`) and the payment and balance-change parsers as
  they are on this branch.

## Owner decisions to confirm

Every product choice this spec makes that the owner did not, every change from the 2026-10-17 version ("Changed:"), and every
deviation from the boards. Each is built as written unless the owner says otherwise.

| # | Choice | Recommendation and why |
|---|---|---|
| 1 | Changed: the routes are the boards' captions, `/v2/mpt/{issuanceId}`, `/holders` and `/transfers`, not `/v2/mpt/issuances/:id` and `/history`; the list is `/v2/tokens?kind=mpt` (D6), and `/v2/mpt/issuances` is dropped (section 7). | Yes: one list of tokens for both kinds, at the paths the explorer's captions name. |
| 2 | Changed: no `mpt_daily` table and no `/stats` route. | Yes: the holders-over-time chart is deferred (brief), and nothing else on the boards needs daily rows. |
| 3 | Changed: no `mpt_holders_by_amount` version set; top holders are sorted when read, over the issuance's current holders (section 7.3). | Yes: rewriting a by-amount set on every touch of a big issuance costs more than the read. The read grows with the issuance's holders; past ~500k holders, bring the set back. |
| 4 | Changed: no MPT payment volume (`paymentCurrencies` stays issued-token only). | Yes: the parser cannot scale an amount (the issuance node is not in a holder-to-holder payment's metadata), and no board shows it. |
| 5 | Changed: a balance change of an MPT is two rows, the holder's and the issuer's mirror, as for a trust line (section 4.3), not one issuer row from `OutstandingAmount`. | Yes: an MPT issuer's rows read as an issued token's issuer's rows do, and each currency of a transaction sums to zero. |
| 6 | New: `GET /v2/mpt?ids=` (1–100 issuance IDs): the ticker, name and scale of each, in request order (section 7.5). | Yes: the explorer shows MPT amounts on transaction and account pages and needs the scale; one call per page, as for names. |
| 7 | Two meanings of "locked": `escrowed_amount` is the ledger's `LockedAmount` (in escrow); `locked_amount` is what the issuer has locked (the board's Locked tile). | Yes: the board's tile means the issuer's lock; the ledger field means escrow. |
| 8 | `change_type: "clawback"` for every row of a `Clawback` transaction, issued tokens included (they had none). | Yes: one word per transaction type. |
| 9 | The metadata (XLS-89) is decoded by the aggregator, leniently: long and short keys, and the early draft's `urls`; `metadata_conforms` says whether it follows XLS-89; the hex is always served (section 5). | Yes: the list's search and the ticker need it server-side; lenient because early issuances predate the final keys. |
| 10 | A transfer's `kind` is `payment` (mints and redemptions included), `clawback`, `lock`, `unlock`, `escrow_create`, `escrow_finish` or `escrow_cancel`. Authorizations and issuance changes are not listed. | Yes: the board lists moves, clawbacks and locks; the account's transaction list has the rest. |
| 11 | MPT amounts stay in the ledger's integer units everywhere (`"124000000"` is 1,240,000.00 at scale 2), with `asset_scale` on issuance objects and `mpt_issuance_id` on amounts (kept from 2026-10-17). | Yes: exact, and the scale is not known where a payment is parsed. |
| 12 | Exchanges, AMM pools and path payments still skip MPT amounts (kept, ruling R12). | Yes: MPTokensV2 (MPT on the DEX) is not enabled. |
| 13 | An issuance whose own ledger entry did not change inside the coverage (created before it, moved only between holders since) has no known state: `/v2/mpt/{id}` answers 404 and the list leaves it out until the reprocess (section 10). | Accept: it ends with the reprocess from the enablement ledger; the explorer falls back to the node. |
| 14 | `/v2/accounts/{address}/mpt` (kept) serves the newest indexed ledger only, with no historical ledger parameter. | Yes: the explorer reads holdings from the node; a historical form can come later. |
| 15 | A brand-new issuance answers 404 on `/v2/mpt/{id}` until the next aggregator tick (about 30 s), as a new AMM pool does. | Accept. |
| 16 | Coverage is D3's `FeatureCoverageService` (`MPT_PARSER_VERSION`, MPTokensV1). On Xahau (`NetworkProfile.hasMpt` false) the routes read nothing and answer `complete: true`: D3's rule for a feature the network cannot have, as D5 applies it to delegation (section 7). | Yes: nothing can be missing where MPT cannot exist. |
| 17 | **Consistency pass:** the MPT amount object is D5's (D5 §5.1: `{ currency: <issuance ID>, issuer, value: <integer units>, mpt_issuance_id }`), built before D9; D9 serves every MPT amount in it and adds the scale and ticker only through `?ids=` (section 7.5). `/v2/accounts/{a}/mpt` puts `coverage` right after `result` (D3's placement), not after `close_time`. | Yes: D5 and E10 show MPT escrows before D9 exists; one placement for every list. |

## Goal

Serve every figure of the Mpt board and of the token list's MPT tab from the index: issuances with their state, flags, decoded
metadata, holders and transfers (clawbacks and locks included); and stop dropping MPT payments from the payment and balance-change
data.

## Scope and non-goals

**In scope:** MPTokensV1 issuances and holders; TokenEscrow's MPT escrows (as transfers and balance changes); MPT payments in
`payments`, `payments_by_currency`, `account_payments` and `balance_changes`; the routes of section 7; `kind=mpt` on D6's list.

**Not in scope:**
- The holders-over-time chart and any daily MPT statistics (deferred by the owner: they need a daily statistics job).
- MPT trades and pools (MPTokensV2 is not enabled); MPT prices and conversions; MPT payment volume (decision 4).
- Confidential balances (ConfidentialTransfer) and permissioned domains on issuances (`DomainID`, SingleAssetVault): not enabled.
  Their fields are not stored; a later parser version adds them.
- Checking metadata against the issuer's domain or toml (the board says nothing is checked).

## 1. How it looks on the ledger

Task 1 of the plan confirms each fact against recorded mainnet transactions and writes what differs into `FINDINGS.md`.

**Enablement on XRPL mainnet** (`packages/shared/config/amendments/xrpl.json`, which agrees with xrpscan's list on 2026-10-24; Task 1
reads each `EnableAmendment` from the node):

| Amendment | Ledger | Date | What it brings here |
|---|---|---|---|
| MPTokensV1 | 99226369 | 2025-10-01 | issuances, holders, payments, clawback |
| fixMPTDeliveredAmount, fixTokenEscrowV1 | 101852417 | 2026-01-27 | `DeliveredAmount` on direct MPT payments; MPT escrow accounting |
| TokenEscrow | 102204929 | 2026-02-12 | MPT escrows (`LockedAmount`) |
| DynamicMPT, MPTokensV2, SingleAssetVault, ConfidentialTransfer | not enabled | | mutable fields, the DEX, domains, confidential balances |

Xahau has no MPT (xahaud has no such amendment). XRPL Testnet has MPTokensV1 and may have DynamicMPT; the coverage reads its enable
ledger by D3's rule, which on a testnet is the indexed `EnableAmendment` only (section 9).

**The issuance ID.** `MPTokenIssuanceID` is 24 bytes, 48 hex digits: the issuance's `Sequence` (4 bytes, big-endian), then the
issuer's AccountID (20 bytes). The issuer and the sequence are read from it.

**`MPTokenIssuance`** (one per issuance): `Issuer`, `Sequence`, `Flags`, `AssetScale` (0 if absent), `MaximumAmount` (absent: 2^63−1,
"not set"), `OutstandingAmount` (held by everyone but the issuer, escrowed amounts included), `LockedAmount` (in escrow), `TransferFee`
(0–50000 in units of 1/100000: `100` is 0.1%), `MPTokenMetadata` (hex, at most 1024 bytes). Flags: `lsfMPTLocked` 0x01 (every balance
is locked), `lsfMPTCanLock` 0x02, `lsfMPTRequireAuth` 0x04, `lsfMPTCanEscrow` 0x08, `lsfMPTCanTrade` 0x10, `lsfMPTCanTransfer` 0x20,
`lsfMPTCanClawback` 0x40. A created node leaves the fields at their default out.

**`MPToken`** (one per holder): `Account`, `MPTokenIssuanceID`, `MPTAmount` (the spendable balance), `LockedAmount` (the holder's
part in escrow). Flags: `lsfMPTLocked` 0x01 (the issuer locked this balance), `lsfMPTAuthorized` 0x02. `MPTokenAuthorize` creates and
deletes it; the issuer holds none.

The UInt64 fields (`MaximumAmount`, `OutstandingAmount`, `LockedAmount`, `MPTAmount`) are base-10 strings in the node's JSON; an MPT
amount in a transaction is `{ "mpt_issuance_id": "<48 hex>", "value": "<integer>" }`.

**Transactions:**
- `MPTokenIssuanceCreate` (`AssetScale`, `MaximumAmount`, `TransferFee`, `MPTokenMetadata`, flags `tfMPTCan*` with the bits above);
  the node adds `mpt_issuance_id` to the metadata.
- `MPTokenIssuanceDestroy` (`MPTokenIssuanceID`).
- `MPTokenIssuanceSet` (`MPTokenIssuanceID`, optional `Holder`; `tfMPTLock` 0x01, `tfMPTUnlock` 0x02): locks or unlocks one holder,
  or, with no `Holder`, every balance. With DynamicMPT it also changes metadata, fee and flags (not on mainnet yet).
- `MPTokenAuthorize` (`MPTokenIssuanceID`, optional `Holder`; `tfMPTUnauthorize` 0x01): a holder opts in or out; the issuer
  authorizes a holder.
- `Payment` with an MPT `Amount`: direct only; with a transfer fee `SendMax` is required and the fee is burned (`OutstandingAmount`
  falls by it). A holder-to-holder payment without a fee does not touch the `MPTokenIssuance` node.
- `Clawback` with an MPT `Amount` and a `Holder`.
- `EscrowCreate`, `EscrowFinish`, `EscrowCancel` with an MPT `Amount` (TokenEscrow): create moves the amount from the holder's
  `MPTAmount` to its `LockedAmount` and adds it to the issuance's `LockedAmount`; finish and cancel move it out again.

## 2. Representation

| Topic | Decision |
|---|---|
| **Asset** | Kept: an MPT is `currency` = the 48 upper-case hex digits of the issuance ID and `issuer` = the issuer's address, in every `(currency, issuer)` column and key (`payments`, `payments_by_currency`, `account_payments`, `balance_changes`). 48 hex digits are always an MPT; 3-character and 40-hex codes stay issued currencies. |
| **Asset syntax** | Kept: `parseAsset` takes `<48hex>` (the issuer is implied) and `<48hex>+<issuer>`; an issuer that is not the ID's answers 400 `issuer does not match mpt issuance`. Lower-case hex is upper-cased like any currency. |
| **Amounts** | The ledger's integer units, never scaled: exact `String` in the existing tables, `UInt64` in the MPT tables (their sums and sorts are exact), integer strings in every answer. Issuance objects carry `asset_scale`; an MPT amount object is D5's (D5 §5.1, built first): `{ currency: <issuance ID>, issuer, value: <integer units>, mpt_issuance_id }`, `mpt_issuance_id` its last key. D9 changes nothing in it; the scale and the ticker come from `?ids=` (7.5). |
| **Flags** | Objects of named booleans in answers (`flags: { locked, can_lock, require_auth, can_escrow, can_trade, can_transfer, can_clawback }`); the raw `UInt32` in tables. A new flag is a new key. |

## 3. Data model

One new migration (the next number; seven `CREATE TABLE IF NOT EXISTS`, additive, depending on no other table). The five ledger
tables are `ReplacingMergeTree` with `non_replicated_deduplication_window = 1000`, in `CHILD_TABLES` and `LEDGER_KEYED_TABLES`,
written by `LedgerWriter` with the ledger's other rows and deleted by recovery and `--reprocess` partition by partition. The two
aggregates are written by the aggregator only (ADR-0008), never by ingest. `Table` members: `MptIssuanceStates`, `MptHolderStates`,
`MptTouches`, `MptTransfers`, `MptIssuanceTransfers`, `MptIssuances`, `MptHolders`; row types `<Member>Row` in `rows.ts`;
`LedgerRows` keys `mptIssuanceStates`, `mptHolderStates`, `mptTouches`, `mptTransfers`, `mptIssuanceTransfers`.

### 3.1 Ledger tables

```sql
-- The state of an issuance after each transaction that changed its MPTokenIssuance node (created, modified with
-- PreviousFields, deleted), whatever the result: the node's final fields (NewFields for a created node).
CREATE TABLE IF NOT EXISTS mpt_issuance_states
(
  mpt_issuance_id    String,                  -- 48 upper-case hex
  ledger_index       UInt32,
  tx_index           UInt32,
  node_index         UInt16,                  -- the node's position in AffectedNodes
  tx_hash            String,
  tx_type            LowCardinality(String),
  close_time         DateTime('UTC'),
  issuer             String,
  sequence           UInt32,
  flags              UInt32,
  asset_scale        UInt8,
  maximum_amount     Nullable(UInt64),        -- NULL: not set (2^63-1)
  outstanding_amount UInt64,
  escrowed_amount    UInt64,                  -- the node's LockedAmount
  transfer_fee       UInt16,
  metadata_hex       String,                  -- '' when none
  deleted            UInt8                    -- 1: MPTokenIssuanceDestroy removed it
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (mpt_issuance_id, ledger_index, tx_index, node_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- The state of a holder's balance after each transaction that changed its MPToken node, by the same rules. Ordered by
-- holder: an account's holdings and the aggregator's per-pair rebuild are prefixes.
CREATE TABLE IF NOT EXISTS mpt_holder_states
(
  holder           String,
  mpt_issuance_id  String,
  ledger_index     UInt32,
  tx_index         UInt32,
  node_index       UInt16,
  tx_hash          String,
  tx_type          LowCardinality(String),
  close_time       DateTime('UTC'),
  amount           UInt64,                    -- MPTAmount
  escrowed_amount  UInt64,                    -- the MPToken's LockedAmount
  flags            UInt32,
  deleted          UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (holder, mpt_issuance_id, ledger_index, tx_index, node_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- Which issuances and holders a transaction touched, in ledger order (holder '' for the issuance's own node): the
-- aggregator's watermark scan and the agg_dirty slices, as amm_pool_touches.
CREATE TABLE IF NOT EXISTS mpt_touches
(
  ledger_index    UInt32,
  tx_index        UInt32,
  mpt_issuance_id String,
  holder          String
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, mpt_issuance_id, holder)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per MPT a successful transaction moved, clawed back, locked or unlocked (section 4.2), in ledger order: what
-- the 24 h counts of the token list read.
CREATE TABLE IF NOT EXISTS mpt_transfers
(
  ledger_index    UInt32,
  tx_index        UInt32,
  mpt_issuance_id String,
  tx_hash         String,
  tx_type         LowCardinality(String),
  close_time      DateTime('UTC'),
  kind            Enum8('payment' = 1, 'clawback' = 2, 'lock' = 3, 'unlock' = 4,
                        'escrow_create' = 5, 'escrow_finish' = 6, 'escrow_cancel' = 7),
  source          String,                     -- '' when none (a lock of every balance)
  destination     String,                     -- '' likewise
  amount          UInt64,
  fee             UInt64                      -- the transfer fee burned; 0 when none
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, mpt_issuance_id)
SETTINGS non_replicated_deduplication_window = 1000;

-- The same rows ordered by issuance: what /v2/mpt/{issuanceId}/transfers reads.
CREATE TABLE IF NOT EXISTS mpt_issuance_transfers
(
  mpt_issuance_id String,
  ledger_index    UInt32,
  tx_index        UInt32,
  tx_hash         String,
  tx_type         LowCardinality(String),
  close_time      DateTime('UTC'),
  kind            Enum8('payment' = 1, 'clawback' = 2, 'lock' = 3, 'unlock' = 4,
                        'escrow_create' = 5, 'escrow_finish' = 6, 'escrow_cancel' = 7),
  source          String,
  destination     String,
  amount          UInt64,
  fee             UInt64
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (mpt_issuance_id, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;
```

The key of `mpt_transfers` holds the issuance, so that a transaction that moves two MPTs (MPTokensV2, later) stays two rows. The copy
ordered by issuance is a full copy rather than a narrow index read twice, as `account_exchanges` is of `exchanges`: MPT transfers are
few and small. **Coverage gate:** `MPT_PARSER_VERSION` in `rows.ts`, the first parser version that writes these tables (D3's pattern,
as `NFT_PARSER_VERSION`): gates compare with it, never with `PARSER_VERSION` (sections 7 and 10).

### 3.2 Aggregates

```sql
-- The current state of each issuance, rebuilt by the mpt_state job (section 6). A recompute writes a whole new row under
-- a newer version; readers keep the newest version of each issuance without FINAL.
CREATE TABLE IF NOT EXISTS mpt_issuances
(
  mpt_issuance_id    String,
  issuer             String,                  -- from the ID
  sequence           UInt32,                  -- from the ID
  state_known        UInt8,                   -- 0: no mpt_issuance_states row in the coverage (decision 13)
  flags              UInt32,
  asset_scale        UInt8,
  maximum_amount     Nullable(UInt64),
  outstanding_amount UInt64,
  escrowed_amount    UInt64,
  locked_amount      UInt64,                  -- outstanding_amount when lsfMPTLocked, else the sum of locked holders' amount
  locked_holders     UInt32,                  -- holders when lsfMPTLocked, else the holders with lsfMPTLocked
  holders            UInt32,                  -- holders with amount + escrowed_amount > 0
  transfer_fee       UInt16,
  metadata_hex       String,
  metadata           String,                  -- the decoded object as JSON (section 5); '' when the hex is not a JSON object
  metadata_conforms  UInt8,
  ticker             String,                  -- from the metadata, cut to 16 characters; '' when none
  name               String,                  -- likewise, cut to 128
  created_ledger     Nullable(UInt32),        -- the MPTokenIssuanceCreate row; NULL when it is outside the coverage
  created_time       Nullable(DateTime('UTC')),
  created_tx_hash    Nullable(String),
  last_ledger        UInt32,                  -- the newest touch (mpt_touches) this row has seen
  destroyed          UInt8,
  version            UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY mpt_issuance_id;

-- The current balance of each holder of each issuance, recomputed per touched (issuance, holder) pair.
CREATE TABLE IF NOT EXISTS mpt_holders
(
  mpt_issuance_id String,
  holder          String,
  amount          UInt64,
  escrowed_amount UInt64,
  flags           UInt32,
  last_ledger     UInt32,
  deleted         UInt8,                      -- the MPToken was deleted (the holder opted out)
  version         UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (mpt_issuance_id, holder);
```

Sizes: a row per issuance ever made (XRPL: hundreds to a few thousand) and a row per MPToken ever made. Both are read whole per
issuance or per list, which section 8 bounds.

### 3.3 Existing tables

`payments`, `payments_by_currency`, `account_payments` and `balance_changes` take MPT rows with no schema change (`currency` is
`LowCardinality(String)`). Their `*_f` shadows hold the unscaled units on an MPT row; no aggregate reads them for MPTs (decision 4).

## 4. Parsing

New files in `packages/shared/src`: `util/mpt-id.ts` (`mptIssuanceId(sequence, issuer)`; `decodeMptIssuanceId(id): { sequence,
issuer }`, which throws on anything but 48 hex digits; `isMptIssuanceId(text)`), `parsers/mpt-deltas.ts` (`mptDeltas(meta)`: per
`MPToken` node the holder, the issuance, `amount` and `escrowed` before and after; per `MPTokenIssuance` node the issuance and
`outstanding` and `escrowed` before and after; shared by the three parsers below) and `parsers/mpt.parser.ts` (`MptParser`). Every
parser stays pure on deep-frozen input. `PARSER_VERSION` moves to the new version.

### 4.1 `MptParser.parse(t, ctx): { issuanceStates, holderStates, transfers }`

- **States**, whatever the transaction's result: one `ParsedMptIssuanceState` per created, modified (with `PreviousFields`) or deleted
  `MPTokenIssuance` node, its ID built from its `Issuer` and `Sequence`; one `ParsedMptHolderState` per such `MPToken` node, its ID
  from `MPTokenIssuanceID`. Absent amounts are 0, an absent `MaximumAmount` is null, a deleted node keeps its final fields with
  `deleted: true`. A modified node without `PreviousFields` was only threaded and has no row.
- **Touches** are made by `buildLedgerRows` from the states: `(ledger_index, tx_index, id, '')` per issuance state and
  `(…, id, holder)` per holder state, once each.
- **Transfers** (section 4.2), `tesSUCCESS` only.

### 4.2 Transfers

| Transaction | `kind` | `source` | `destination` | `amount` | `fee` |
|---|---|---|---|---|---|
| `Payment`, MPT `Amount` (or `DeliverMax`) | `payment` | `Account` | `Destination` | what was delivered: `DeliveredAmount`, else `delivered_amount`, else `Amount` (the existing `deliveredAmount` rule; before fixMPTDeliveredAmount the metadata has neither) | the sender's fall of `MPTAmount` less `amount` when the sender is not the issuer, else 0 |
| `Clawback`, MPT `Amount` | `clawback` | `Holder` | `Account` (the issuer) | the holder's fall of `MPTAmount` (what was taken, which can be less than asked) | 0 |
| `MPTokenIssuanceSet` with `tfMPTLock` | `lock` | `Account` | `Holder`, or `''` for every balance | the holder's `MPTAmount` after it, or the issuance's `OutstandingAmount` | 0 |
| the same with `tfMPTUnlock` | `unlock` | as for `lock` | | | 0 |
| `EscrowCreate`, MPT `Amount` | `escrow_create` | `Account` | `Destination` | `Amount` | 0 |
| `EscrowFinish` of an MPT escrow (the deleted `Escrow` node's `Amount` is an MPT) | `escrow_finish` | the escrow's `Account` | its `Destination` | the escrow's `Amount` | `amount` less what the destination got, when above 0 (Task 1 confirms whether a fee applies) |
| `EscrowCancel` of an MPT escrow | `escrow_cancel` | the escrow's `Account` | the same account (the amount returns) | the escrow's `Amount` | 0 |

A mint is a `payment` from the issuer and a redemption a `payment` to it, as on the ledger. An `MPTokenIssuanceSet` that only changes
metadata, fee or flags (DynamicMPT) and every `MPTokenAuthorize` give states and no transfer. `mpt_issuance_transfers` gets a copy of
each row.

### 4.3 Payments and balance changes: what this sub-project fixes and what it leaves

| Parser | Today | D9 |
|---|---|---|
| `payment.parser.ts:41,80` | drops a payment whose `Amount`, `SendMax`, `DeliveredAmount` or `delivered_amount` is an MPT | **Fixed.** `currency` = the ID, `issuer` = the ID's issuer, `amount`, `delivered_amount` and `max_amount` in integer units, `source_currency` the ID. The MPT entries of `source_balance_changes` and `destination_balance_changes` come from `mptDeltas` (`ripple-lib-transactionparser` knows no `MPToken`): a holder's is `{ counterparty: <issuer>, currency: <id>, value: <its MPTAmount change> }`; the issuer's, when it sends or receives, is the change of `OutstandingAmount` negated, with the other party as `counterparty`. |
| `balance-changes.parser.ts` | ignores `MPToken` nodes | **Fixed.** Each `MPToken` node whose `MPTAmount` changed gives two rows at its `node_index`, as a `RippleState` does: the holder's (`counterparty` = the issuer, `amount_change` = the change, `final_balance` = `MPTAmount` after) and the issuer's mirror (`counterparty` = the holder, both negated). `changeType` reads the currency of an MPT `Amount` or `SendMax` as its `mpt_issuance_id`; every row of a `Clawback` is `clawback` (decision 8); MPT escrows take the escrow types through the existing `Escrow` node map (`escrowValue` already reads an object's `value`). A created `MPToken` with nothing on it is no change. |
| `exchanges.parser.ts:136`, `amm.parser.ts:275` | skip MPT amounts | **Left** (decision 12): no MPT trade or pool can exist until MPTokensV2. |
| `path-payments.parser.ts:143` | skips MPT payments | **Left**: an MPT payment is direct, so it is never a path payment. |

**Invariants** (golden tests): per transaction and issuance, the holder rows and the issuer's mirror rows sum to zero; the holders'
`MPTAmount` changes plus the `OutstandingAmount` change sum to zero except for escrow moves and clawbacks; the escrowed amounts of the
holders and of the issuance move together.

## 5. Metadata (XLS-89)

`packages/shared/src/util/mpt-metadata.ts`: `decodeMptMetadata(hex): MptMetadata | undefined`, used by the `mpt_state` job when it
rebuilds an issuance. The explorer does not decode it: it shows what the API decoded, and the raw hex.

- **Bytes.** Hex to bytes (at most 1024), UTF-8 with `fatal`, then `JSON.parse`. Not UTF-8, not JSON, or JSON that is not an object:
  `undefined` (`metadata` is `''` and `metadata_conforms` 0; the hex is still served).
- **Keys, long or short** (XLS-89 recommends the short ones): `t`/`ticker`, `n`/`name`, `d`/`desc`, `i`/`icon`, `ac`/`asset_class`,
  `as`/`asset_subclass`, `in`/`issuer_name`, `us`/`uris` (items `u`/`uri`, `c`/`category`, `t`/`title`), `ai`/`additional_info`; and
  the early draft's `urls` (items `url`, `type`, `title`), read as `uris`. The long key wins when both are present. The result uses
  the long names, in that order.
- **Lenient.** A field is kept when it has the right type (strings; `uris` an array of objects whose `uri` is a string;
  `additional_info` an object or a string), each string cut to 1024 characters; anything else is dropped, and so are unknown keys.
- **`metadata_conforms`** is 1 when every rule of XLS-89 holds: `ticker` of 1–6 characters A–Z and 0–9; `name`, `icon`, `asset_class`
  and `issuer_name` present; `asset_class` one of `rwa, memes, wrapped, gaming, defi, other`; `asset_subclass` one of `stablecoin,
  commodity, real_estate, private_credit, equity, treasury, other`, and present when `asset_class` is `rwa`; every `uris` item has a
  `uri`, a `title` and a `category` among `website, social, docs, other`.
- **The `ticker` and `name` columns** are the decoded strings, cut to 16 and 128 characters, whether or not they conform; nothing is
  checked against the issuer's domain. URLs are served as written: the explorer decides what it links (E14).

## 6. Aggregation: the `mpt_state` job

`packages/shared/src/aggregate/mpt-state.job.ts` (the reads and writes) and `apps/syncer/src/aggregator/mpt-state.job-runner.ts` (the
runner), registered in `aggregator.service.ts` as `mpt_state`: every tick, budget `AGGREGATOR_MPT_STATE_BUDGET_MS` = 3000. It follows
the `amm_pools` runner in every rule not restated here: committed head only, a cursor in memory found again at start, stale-only
batches, halving a failed batch and setting failed issuances aside, R86 and R87, and a shutdown aborts it before a write.

- **Cursor.** `mptStateWatermark(ch)`: the ledger before the oldest `mpt_touches` row above its issuance's `last_ledger` (newest
  `mpt_issuances` row), else the head.
- **Each tick** `mptIssuancesChangedSince(ch, cursor, head, MPT_STATE_BATCH)` (200) returns the stale issuances, oldest first, each
  with the holders touched since its `last_ledger` (a range of `mpt_touches`' key, up to the head). For each issuance:
  1. `recomputeMptHolders(ch, pairs, head)`: the newest `mpt_holder_states` row at or before the head of each touched pair
     (`(holder, mpt_issuance_id) IN …`, a prefix each), written to `mpt_holders` under a new version, `MPT_HOLDERS_CHUNK` (5,000)
     pairs per insert. A pair with no state row left (a re-ingest dropped it) is deleted from `mpt_holders`.
  2. `recomputeMptIssuances(ch, ids, head)`: the newest `mpt_issuance_states` row at or before the head; the creation (the oldest row
     with `tx_type = 'MPTokenIssuanceCreate'`); `holders`, `locked_amount` and `locked_holders` from the issuance's `mpt_holders`
     (newest version per holder, `deleted = 0`); the decoded metadata (section 5); `last_ledger`, the newest touch seen. With no state
     row it writes `state_known = 0` and the state columns at their defaults. An issuance with neither a state row nor a holder row
     left is deleted from both tables (R-A28's rule).
  The cursor passes an issuance only once its row is written. The holders are written first, so a reader never sees a count ahead of
  the rows it counts.
- **Version:** the ClickHouse clock in milliseconds, never below one more than the row's newest version.
- **`agg_dirty`:** `stats_dirty` also rebuilds, per slice, the issuances with a touch in the slice's ledgers and those whose
  `last_ledger` is in them (error label `mpt_state_dirty`).
- **Cost.** A rebuild reads the touched pairs and all the issuance's holder rows: its holders, not its history. An airdrop to 50,000
  holders in one ledger is ten inserts in one tick. The aggregator's no-starvation test registers every job of program 2.
- **Observability:** the usual per-job duration and error metrics, and the gauge `syncer_mpt_state_lag_ledgers` (head minus cursor).

## 7. Endpoints

GateHub extras (no Ripple original), on the usual contract: errors, key, `limit`, markers and `Link`, CSV, key order pinned by tests.
Errors are listed in the order they are checked. A route that names an issuance checks the ID first: 400 `invalid mpt issuance id`
unless it is 48 hex digits (either case; answers use upper case).

**Coverage** is D3's shared `FeatureCoverageService` (`apps/api/src/common/feature-coverage.service.ts`, D3 §4), not a service of its
own: the MPT feature is `{ parserVersion: MPT_PARSER_VERSION, amendment: 'MPTokensV1' }` on XRPL and XRPL Testnet (by the network's
family). It gives D3's `"coverage": { "from_ledger_index", "complete" }`, right after `result` (D3's placement, as in D6's envelope),
cached 60 s: `from_ledger_index` one above the newest stored ledger a parser older than `MPT_PARSER_VERSION` wrote (else the oldest
stored ledger), `complete` when it is at or below MPTokensV1's enable ledger (the indexed `EnableAmendment`, else, on a mainnet, the
amendment metadata file), gaps not looked at. **On a network without MPT** (`NetworkProfile.hasMpt`, new: true on XRPL and XRPL Testnet,
false on Xahau and Xahau Testnet): D3's rule for a feature the network cannot have, as D5 applies it to delegation (`hasDelegation`):
the routes read no MPT table, and `coverage` is the service's `from_ledger_index` for `MPT_PARSER_VERSION` with `complete: true` (there
is nothing to miss). Nothing is added to D3's service.

### 7.1 `GET /v2/tokens?kind=mpt` (additive to D6)

D6's route and envelope (D6 §5.1 and §8): `result, coverage, kind, ledger_index, close_time, totals, total, total_below?, count,
marker?, tokens`; its `min_holders`, `q`, `limit` (200, max 1000), `marker` (which holds the kind) and `format` (`csv`: `tokens.csv`);
its order by holders. D9 adds `mpt` to `kind` (the message becomes `invalid kind - use: issued, mpt`), the MPT row, the MPT `totals`
and the MPT search; `TokensController` hands `kind=mpt` to `MptTokensService` (`apps/api/src/mpt/mpt-tokens.service.ts`). D9 changes
nothing of `kind=issued`.

- **Rows:** the issuances with `state_known = 1` (decision 13) and `destroyed = 0`, at least `min_holders` holders, matching `q`.
  Order: `holders` descending, then `issuer`, then `mpt_issuance_id`; `rank` is the row's place in it among the selected issuances;
  the marker holds `(holders, issuer, mpt_issuance_id)`.
- **`q`:** a classic address selects that issuer's issuances; 48 hex digits (any case) that issuance; otherwise an issuance matches when
  its `ticker` or `name` contains `q` (case-insensitive), its ID starts with `q` (8 hex digits or more), or its issuer starts with `q`.
  D6's length rule and `invalid search` apply.
- **`ledger_index`, `close_time`:** the newest committed ledger when the list is read (the aggregate trails it by at most a tick).
- **`total`, `total_below`:** D6's counts, over issuances.

```json
{ "result": "success", "coverage": { "from_ledger_index": 99226369, "complete": true },
  "kind": "mpt", "ledger_index": 107795512, "close_time": "2026-10-24T14:20:01Z",
  "totals": { "issuances": 214, "holders": 9862, "transfers_24h": 2415 },
  "total": 214, "count": 1, "marker": "…",
  "tokens": [{ "rank": 1, "mpt_issuance_id": "0000012A…", "issuer": "r…", "ticker": "HTF", "name": "Harborline Treasury Fund",
               "asset_scale": 2, "maximum_amount": "5000000000", "outstanding_amount": "1820451120", "holders": 3412,
               "transfer_fee": 100, "flags": { "locked": false, "can_lock": true, "require_auth": true, "can_escrow": false,
               "can_trade": true, "can_transfer": true, "can_clawback": true }, "transfers_24h": 412 }] }
```

**The MPT row**, in this order: `rank, mpt_issuance_id, issuer, ticker?, name?, asset_scale, maximum_amount?, outstanding_amount,
holders, transfer_fee, flags, transfers_24h`. `transfers_24h` counts the issuance's `payment` rows (`uniqExact((ledger_index,
tx_index))`) in the ledgers that closed in the 24 hours before the newest committed ledger closed, read from `mpt_transfers` by that
ledger range for the page's IDs. **Totals** (whatever the filters, as D6's): `issuances` (live, with a known state, whatever their
holders), `holders` (distinct accounts with a positive balance of at least one of them, `uniqExact(holder)` over the newest
`mpt_holders` rows) and `transfers_24h` (every MPT payment of the window). Errors: D6's, in its order (`invalid kind - use: issued,
mpt`, `invalid min_holders`, `invalid search`, `invalid marker`); 500 `unable to retrieve tokens`.

### 7.2 `GET /v2/mpt/{issuanceId}`

```json
{ "result": "success", "coverage": { "from_ledger_index": 99226369, "complete": true },
  "issuance": {
    "mpt_issuance_id": "0000012A…", "issuer": "r…", "sequence": 298, "ticker": "HTF", "name": "Harborline Treasury Fund",
    "asset_scale": 2, "maximum_amount": "5000000000", "outstanding_amount": "1820451120", "escrowed_amount": "0",
    "locked_amount": "124000000", "locked_holders": 1, "holders": 3412, "transfer_fee": 100,
    "flags": { "locked": false, "can_lock": true, "require_auth": true, "can_escrow": false, "can_trade": true,
               "can_transfer": true, "can_clawback": true },
    "metadata": { "ticker": "HTF", "name": "Harborline Treasury Fund", "desc": "…", "icon": "harborline.example/htf/icon.png",
                  "asset_class": "rwa", "asset_subclass": "treasury", "issuer_name": "Harborline Capital",
                  "uris": [{ "uri": "harborline.example/htf", "category": "website", "title": "Fund page" }] },
    "metadata_hex": "7B227469636B6572…", "metadata_conforms": true,
    "created_ledger": 99412004, "created_time": "2025-10-09T11:20:31Z", "created_tx_hash": "…",
    "last_ledger": 107795512, "destroyed": false } }
```

**MptIssuance**, in this order: `mpt_issuance_id, issuer, sequence, ticker?, name?, asset_scale, maximum_amount?, outstanding_amount,
escrowed_amount, locked_amount, locked_holders, holders, transfer_fee, flags, metadata?, metadata_hex?, metadata_conforms?,
created_ledger?, created_time?, created_tx_hash?, last_ledger, destroyed`. `metadata` only when it was decoded; `metadata_hex` and
`metadata_conforms` when the issuance has metadata; the `created_*` fields when the creation is in the coverage. A destroyed issuance
is served (`destroyed: true`). Errors: 400 `invalid mpt issuance id`; 404 `issuance not found` (there is none, its state is outside the
coverage, or it is newer than the last tick); 500 `unable to retrieve issuance`. No CSV.

### 7.3 `GET /v2/mpt/{issuanceId}/holders`

| Parameter | Default | Meaning |
|---|---|---|
| `include_zero` | false | Boolean: also the holders with nothing (an authorized, empty balance). |
| `limit`, `marker` | 200 (max 1000) | The marker holds the balance and the holder of the last row. |
| `format` | json | `csv`: file `<issuanceId> - holders.csv`. |

```json
{ "result": "success", "coverage": { "from_ledger_index": 99226369, "complete": true }, "count": 1, "marker": "…",
  "holders": [{ "holder": "r…", "amount": "612040000", "escrowed_amount": "0", "locked": false, "authorized": true }] }
```

**MptHolder**, in this order: `holder, amount, escrowed_amount, locked, authorized`; ordered by `amount + escrowed_amount` descending,
then `holder`. `locked` is true when the balance cannot move: the holder's own `lsfMPTLocked`, or the issuance's. `authorized` is the
holder's `lsfMPTAuthorized` (meaningful when the issuance requires it). The read: the issuance's rows of `mpt_holders`, the newest
version per holder (`ORDER BY holder, version DESC LIMIT 1 BY holder` in a subquery), then `deleted = 0`, the balance condition, the
keyset on `(9223372036854775807 - (amount + escrowed_amount), holder)`, `ORDER BY` that and `LIMIT limit + 1`. Errors: 400 `invalid
mpt issuance id`, `invalid marker`; 404 `issuance not found` (no `mpt_issuances` row); 500 `unable to retrieve holders`.

### 7.4 `GET /v2/mpt/{issuanceId}/transfers`

| Parameter | Default | Meaning |
|---|---|---|
| `kind` | all | A comma list of `payment, clawback, lock, unlock, escrow_create, escrow_finish, escrow_cancel`. |
| `account` | all | Only the rows with this account as source or destination (not validated, as the AMM lists' `account`). |
| `start`, `end`, `descending`, `limit` (200, max 1000), `marker` | | The marker holds `ledger_index, tx_index`. |
| `format` | json | `csv`: file `<issuanceId> - transfers.csv`. |

```json
{ "result": "success", "coverage": { "from_ledger_index": 99226369, "complete": true }, "count": 1, "marker": "…",
  "transfers": [{ "ledger_index": 107795410, "tx_index": 31, "tx_hash": "…", "executed_time": "2026-10-24T14:11:05Z",
                  "tx_type": "Payment", "kind": "payment", "source": "r…", "destination": "r…", "amount": "2500000" }] }
```

**MptTransfer**, in this order: `ledger_index, tx_index, tx_hash, executed_time, tx_type, kind, source?, destination?, amount, fee?`
(`source` and `destination` are left out when `''`; `fee` only above 0). The read is a `readDistinctPage` over
`mpt_issuance_transfers`: `ORDER BY mpt_issuance_id, ledger_index, tx_index`, unique `(ledger_index, tx_index)`, with `kind` and
`account` as conditions of the capped read itself. Errors: 400 `invalid mpt issuance id`, `invalid start date format`, `invalid end
date format`, `invalid kind - use: payment, clawback, lock, unlock, escrow_create, escrow_finish, escrow_cancel`, `invalid marker`;
404 `issuance not found`; 500 `unable to retrieve transfers`.

### 7.5 `GET /v2/mpt?ids=<id1>,<id2>,…`

1–100 issuance IDs, answered in request order: `{ "result": "success", "count": N, "issuances": [MptSummary, …] }`, where
**MptSummary** is, in this order, `mpt_issuance_id, issuer, ticker?, name?, asset_scale, maximum_amount?, outstanding_amount, holders,
transfer_fee, flags, destroyed`. An ID without an `mpt_issuances` row (or with `state_known = 0`) is `{ "mpt_issuance_id": "…" }`
alone. A read by the primary key (`mpt_issuance_id IN …`, the newest version of each). No coverage (it lists nothing), no paging, no
CSV. Errors: 400 `ids is required`, `too many ids` (more than 100), `invalid mpt issuance id`; 500 `unable to retrieve issuances`.

### 7.6 `GET /v2/accounts/{address}/mpt`

The account's holdings at the newest indexed ledger, by issuance ID: `include_zero` (false), `limit` (200, max 1000), `marker` (the ID
of the last row), `format=csv` (file `<address> - mpt.csv`).

```json
{ "result": "success", "coverage": { "from_ledger_index": 99226369, "complete": true },
  "ledger_index": 107795512, "close_time": "2026-10-24T14:20:01Z", "count": 1,
  "mpt": [{ "mpt_issuance_id": "…", "issuer": "r…", "ticker": "HTF", "name": "…", "asset_scale": 2, "amount": "612040000",
            "escrowed_amount": "0", "locked": false, "authorized": true }] }
```

Key order: `result, coverage, ledger_index, close_time, count, marker?, mpt` (D3's placement, as D5's answers); a holding is `mpt_issuance_id, issuer, ticker?, name?,
asset_scale?, amount, escrowed_amount, locked, authorized`, the issuance's fields from `mpt_issuances` for the page's IDs. The read:
the account's prefix of `mpt_holder_states` up to the head, `ORDER BY mpt_issuance_id, ledger_index DESC, tx_index DESC, node_index
DESC LIMIT 1 BY mpt_issuance_id`, then `deleted = 0`. Errors: 400 `invalid ripple address`, `invalid marker`; 500 `unable to retrieve
mpt holdings`.

### 7.7 Existing routes

- `/v2/payments/{currency}` takes `<48hex>[+<issuer>]` and lists that issuance's payments; `/v2/payments`, `/v2/accounts/{a}/payments`
  (whose `currency` filter takes an ID) and `/v2/accounts/{a}/balance_changes` include MPT rows. On an MPT row `mpt_issuance_id` is
  the last key (after `transaction_cost` of a payment, after `tx_hash` of a balance change); the CSV adds its column where a row of the
  page has one, as for `amm_account`.
- `/v2/accounts/{a}/balance_changes` accepts `change_type=clawback`, and its error message lists it.
- Ripple parity: the recorded and ripple-mock fixtures hold no MPT, so every existing parity test stays byte-identical.

## 8. Query bounds

Pinned by `paged-reads.e2e-spec.ts` and the plan tests of `test/support/plans.ts`.

| Read | Bound |
|---|---|
| `/transfers` | `expectBoundedInOrderRead` on `mpt_issuance_transfers`: about a granule of each part past the marker, at any depth |
| `/holders` | read_rows at most 2 × the issuance's `mpt_holders` rows; a test seeds 20,000 holders over four parts |
| `/v2/tokens?kind=mpt` | read_rows at most 2 × the `mpt_issuances` rows (the list and its counts) plus the `mpt_transfers` rows of the 24 h range plus the `mpt_holders` rows (the distinct holders); EXPLAIN shows a primary-key range on `ledger_index` for `mpt_transfers` |
| `/v2/mpt?ids=`, `/v2/mpt/{id}` | EXPLAIN: the primary key on `mpt_issuance_id` |
| `/accounts/{a}/mpt` | read_rows at most 2 × the account's `mpt_holder_states` rows |
| `mpt_state` | a rebuild of 200 issuances reads their touched pairs and their holder rows; checked with 120,000 holders on one issuance |

Every read is capped at the committed head (`ledgers`), as the AMM readers are.

## 9. XRPL, Xahau and the testnets

- **Enable ledger:** no profile field holds it (the profile gains only `hasMpt`, true for the XRPL family). The coverage reads
  MPTokensV1's enable ledger as D3 does: the indexed `EnableAmendment`, else `packages/shared/config/amendments/xrpl.json` (which
  already holds 99226369). On XRPL Testnet it is the testnet's own indexed `EnableAmendment` only (D-env drops the family file's enable
  ledgers on a testnet), so the sandbox answers `complete: false` unless it indexed that ledger (Task 1 records the ledger in FINDINGS).
- **Xahau:** the parsers find no MPT node, so nothing is written; the schema is the same. With `hasMpt` false (section 7) no route
  reads an MPT table: `kind=mpt` answers an empty list with `complete: true`; `/v2/mpt/{id}` and its lists answer 404 `issuance not
  found`; `?ids=` answers bare IDs; `/accounts/{a}/mpt` is an empty list with `complete: true`.
- **XRPL Testnet** may have DynamicMPT, so flags, metadata and fee can change after creation. Every state row keeps them, so the
  current state follows; nothing else differs.

## 10. Backfill, reprocess and coverage

- **Rollout.** Apply the migration before the syncer of the new parser version (its writes fail without the tables), then deploy the
  syncer and the api together.
- **Coverage** starts at the deploy. To complete it, reprocess from MPTokensV1's enablement to the live checkpoint: `range-ingest --from
  99226369 --to <checkpoint> --reprocess` (about 8.5 million ledgers on 2026-10-24; every table of each ledger is rewritten, so it
  costs what the first ingest did; see `backfill.md`, "Which node?"). The `agg_dirty` marks of each chunk make `mpt_state` rebuild the
  issuances touched. Program 2 moves the parser version several times: one reprocess after the last of them covers them all.
- **Until then** (decision 13) an issuance whose node did not change since the deploy has `state_known = 0`, `complete` is false, and
  the explorer says so under its lists.
- **Check:** `SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 99226369 GROUP BY parser_version;` and
  `SELECT countIf(state_known = 0) FROM (SELECT * FROM xrpl.mpt_issuances ORDER BY mpt_issuance_id, version DESC LIMIT 1 BY
  mpt_issuance_id);`.

## 11. Docs to update

- `docs/api-reference.md`: a new "MPT" section (sections 7.1–7.6, the coverage object, the representation of section 2); MPT rows in
  Payments and in balance changes (removing "Payments with MPT amounts are not payments of this API"); `clawback` among the change
  types; the asset syntax. Its examples are checked by `api-reference-examples.e2e-spec.ts`.
- ADR-0010: a new amendment section, with items for MPT payments as payments, MPT balance changes and `clawback`, the asset syntax,
  `mpt_issuance_id` and integer units, and the new extra routes.
- A new ADR, "MPT data" (numbered when it is written): the representation, the state tables and the two aggregates, the holder order
  at read time, the lenient metadata decoding.
- `docs/data-model.md` (the seven tables and the counts), `docs/syncer.md` (the parser, the `mpt_state` job), `docs/backfill.md` (an
  "MPT data re-ingest" section with the enablement ledger and the coverage check), `docs/operations.md` (rollout, the lag gauge) and
  `docs/openapi.yaml` (regenerated).

## 12. Testing

- **Fixtures (Task 1)**, recorded with `record:fixtures --txs` from `wss://s2.ripple.com` (at most two requests in flight) into
  `packages/shared/test/fixtures/xrpl/mpt/`, with `manifest.json` and `FINDINGS.md`. Cases: `issuance_create` (metadata with long keys),
  `issuance_create_short_keys`, `issuance_create_raw_metadata` (not JSON), `issuance_create_no_max`, `issuance_set_lock_holder`,
  `issuance_set_unlock_holder`, `issuance_set_lock_all`, `issuance_destroy`, `authorize_holder`, `authorize_by_issuer`,
  `unauthorize_holder`, `payment_holder_to_holder`, `payment_mint`, `payment_redeem`, `payment_transfer_fee`,
  `payment_before_delivered_fix` (before ledger 101852417), `payment_failed` (a `tec`), `clawback_full`, `clawback_partial`,
  `escrow_create`, `escrow_finish`, `escrow_cancel` (after ledger 102204929), and the `EnableAmendment` ledgers of section 1. A case
  that cannot be found is listed in FINDINGS with why.
- **Unit:** `mpt-id.spec` (round trip; bad input throws); `mpt-metadata.spec` (long, short and draft keys, not JSON, oversize, each
  conformance rule); `mpt.parser.spec` (every case gives its states and transfers; the input deep-frozen); `payment.parser.spec` and
  `balance-changes.parser.spec` (the MPT cases, the invariants of 4.3, the transfer fee, escrow typing, `clawback`); the `build-rows`
  snapshot and key uniqueness per table; every existing golden snapshot unchanged; `asset-param.spec` (the syntax, the issuer mismatch).
- **Shared e2e:** migrations (the seven tables; partitions equal to `LEDGER_KEYED_TABLES`); the ledger writer, recovery and
  `--reprocess` leave no orphans in the five ledger tables; `mpt-state-job.e2e-spec.ts` (state rows to aggregates, holder counts and
  locked sums, `state_known = 0`, removal, 120,000 holders, idempotence, duplicate rows, `agg_dirty` slices).
- **API e2e:** `mpt.e2e-spec.ts` (7.2–7.5: key order, 404s, coverage incomplete and complete, filters, concatenated marker pages, CSV),
  `tokens-mpt.e2e-spec.ts` (7.1: order, `q`, totals, the 24 h window), `account-mpt.e2e-spec.ts`; MPT rows in `payments.e2e-spec.ts`,
  `account-payments.e2e-spec.ts` and `account-balance-changes.e2e-spec.ts`; `paged-reads.e2e-spec.ts` and the plans of section 8; the
  Xahau answers of section 9; the aggregator's no-starvation test.
- **Live check (bounded):** range-ingest 300 ledgers around three recorded issuances' recent activity, then compare each issuance with
  `ledger_entry` (`mpt_issuance`) and three holders with `ledger_entry` (`mptoken`) at the same ledger, and three payments' delivered
  amounts with `tx`. Stop on a rate-limit answer.

## Out of scope

- MPT on the DEX and in AMM pools; MPT prices and conversions (MPTokensV2).
- Daily MPT statistics and the holders-over-time chart (deferred).
- Holdings and holders at a past ledger.
- The fields of amendments that are not enabled (ConfidentialTransfer, `DomainID`, DynamicMPT's `ImmutableFlags`): a later parser
  version.
