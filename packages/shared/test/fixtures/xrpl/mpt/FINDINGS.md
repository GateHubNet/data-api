# XRPL MPT fixtures: findings

Recorded 2026-10-31. Each fact says how it was checked; a count covers everything read, recorded or not. `src/parsers/mpt-fixtures.spec.ts` pins what each case is for, the facts of (1) and the fee of (7). This page is what the parser tasks rely on.

- **Mainnet (`xrpl/mpt/`):** from `wss://s2.ripple.com` (Clio 2.8.0, network id 0; validated head 108026259), one request in flight, `--delay-ms 3000`. 27 ledgers, 1.25 MB gzipped, largest 90 KB (ledger 106427568). They hold 22 cases, three supporting transactions and the three enable ledgers: 99226369 (57 KB), 101852417 (71 KB), 102204929 (60 KB).
- **XRPL Testnet (`xrpl-testnet/mpt/`):** from `wss://clio.altnet.rippletest.net:51233` (Clio 2.8.0, network id 1; validated head 21966420), same pace. 5 ledgers, 22 KB gzipped. They hold `escrow_cancel`, three cases the plan did not name (`escrow_create_transfer_fee`, `escrow_finish_transfer_fee`, `escrow_finish_creates_token`) and one supporting transaction.

## What this changes of spec §1 and §4

- **`PreviousFields` can be present and empty.** A first credit and an issuance's first escrow are modified nodes with `PreviousFields: {}`. Spec §4.1's "modified (with `PreviousFields`)" must test for the key, not for a listed field: `{}` is a change. No MPT node read lacked the key. See (1).
- **`DeliveredAmount` is not on every direct payment after the fix.** It is on none of 1,508. And `delivered_amount` is served before the fix too, against the brief's and spec §4.2's "neither". See (5).
- **`EscrowFinish` charges a transfer fee** when neither end is the issuer, taken out of the locked amount, not on top of it. See (7).
- **MPT escrows exist on mainnet**, against `xrpl/objects` finding 8, which read other accounts. No cancel of one was found there, so `escrow_cancel` is from XRPL Testnet. See (6) and (8).
- **XRPL Testnet does not have `DynamicMPT`:** not enabled at ledger 21965960. See (9).
- Everything else in spec §1 held.

## Where the cases came from

- **Issuers.** `https://api.xrpscan.com/api/v1/mptokens?limit=5000`, read 2026-10-31: 564 issuances of 113 issuers. The listing was used only for addresses; every fact here comes from a node. No mainnet `ledger_data`, and no `--want --scan`.
- **Mainnet histories.** `account_tx` of the 113 issuers on `s2`, `limit: 200`, one request at a time: 38,972 rows, of which 3,796 touch an MPT (1,627 Payment, 1,242 MPTokenAuthorize, 557 MPTokenIssuanceCreate, 179 MPTokenIssuanceDestroy, 65 EscrowCreate, 53 Clawback, 40 Batch, 22 MPTokenIssuanceSet, 6 DelegateSet, 5 EscrowFinish). 99 histories were read to their end. 14 busy ones were capped at 5 to 16 pages from both ends.
- **Rate limits.** `s2` answered `slowDown` (HTTP 503) three times during that search: after 26 requests 200 ms apart, 77 requests 1.5 s apart and 139 requests 5 s apart. Each time the run stopped and resumed minutes later with a longer delay. The last 16 ran clean at 8 s.
- **The two fee payments** did not show in the capped histories. They came from walking back the `PreviousTxnID` of an issuance whose `OutstandingAmount` was not a round number (`ledger_entry`, then `tx`; `0598F6E0…`).
- **XRPL Testnet.** A bounded sample of `ledger_data` on the Clio: 210 pages of `escrow` and 243 pages of `mpt_issuance`, under 0.3% of the state each. Then `account_tx` of the 26 accounts it named: 2,774 rows, 1,978 touching an MPT (414 EscrowCreate, 64 EscrowFinish, 1 EscrowCancel).
- **Supporting transactions** (in the manifests' `txs`, not cases):
  - `B406BE4AB3CABF8C76FD2653D4C83311FEB2F950D02906A95D2B3F3A818AFE50` (ledger 99558158): unlocks what `issuance_set_lock_all` locked.
  - `56133344D8A327F2602CF9A86EEB327B10FA16F7EFBD7805B6F759EE74E78FB4` (107211747): a second escrow, where `LockedAmount` is listed.
  - `CDA244FDA8F78E6EAB40EA6E6879DB0DA0E0C22208F6791D10D5AA4FFD74A118` (107211751): the last finish, where `LockedAmount` leaves `FinalFields`. These two share the issuance of `escrow_create` and `escrow_finish`.
  - Testnet: `E4C5B9949E1883FB5DF1264F798F1D832B024884C82ABEA31557F1C9628100A2` (ledger 19636036): the create of `escrow_cancel`.

## Findings

### (1) An added field is not in `PreviousFields` (C3)

Confirmed on every shape, and the same in the stored metadata (`tx` with `binary: true`, decoded: `payment_mint`'s `MPToken` has `PreviousFields` `{}`).

- First credit, `payment_mint`, the holder's `MPToken`: `ModifiedNode`, `PreviousFields` `{}`, `FinalFields.MPTAmount` "1". `payment_before_delivered_fix` is the same, so the fix did not change it.
- First credit by a finish, `escrow_finish`, the destination's `MPToken`: `PreviousFields` `{}`, `FinalFields.MPTAmount` "277073".
- First escrow, `escrow_create`, the holder's `MPToken`: `PreviousFields` `{ MPTAmount: "954219" }` alone, `FinalFields.LockedAmount` "277073". The `MPTokenIssuance` node: `PreviousFields` `{}`, `FinalFields.LockedAmount` "277073".
- Second escrow, `56133344…`: `LockedAmount` is listed on both ("277073").
- A cancel by an owner who had put in all it held, `escrow_cancel` (testnet): `PreviousFields` `{ LockedAmount: "10000" }` alone, `FinalFields.MPTAmount` "10000", so `MPTAmount` was added.
- Counts on mainnet: 671 `MPToken` nodes with `{}` (666 Payment, 5 EscrowFinish), 9 `MPTokenIssuance` nodes with `{}` (all EscrowCreate), and none of 2,902 other modified nodes lacks the key.
- Metadata alone does not tell added from unchanged: `escrow_create`'s token lists `MPTAmount` and not the added `LockedAmount`. Ruling C3's rule (the transaction says which) fits every shape above.
- `OutstandingAmount` needs no such rule: a first mint lists it (`payment_mint`: `PreviousFields.OutstandingAmount` "0").
- A field that falls to 0 is listed and leaves `FinalFields`: `clawback_full` (`MPTAmount` "1", then absent), `payment_redeem`, `payment_holder_to_holder`'s sender, and `LockedAmount` on both nodes of `CDA244FD…`. Absent reads 0.

### (2) The ID layout

`mptIssuanceId(Sequence, Issuer)` of the `CreatedNode` equals `meta.mpt_issuance_id` on 530 of 530 successful creates read on mainnet. `issuance_create`: `Sequence` 66652146 is `03F907F2`, followed by the issuer's AccountID. 16 of the creates used a ticket: `tx.Sequence` is 0 and the node's `Sequence` is the ticket, so the ID must be built from the node (`NewFields.Sequence`), as C30(b) says.

### (3) UInt64 fields are base-10 strings

7,734 values of `MaximumAmount`, `OutstandingAmount`, `LockedAmount` and `MPTAmount` read on mainnet, in `FinalFields`, `NewFields` and `PreviousFields`: all are digit strings. `payment_transfer_fee`: `OutstandingAmount` "199999998994110". `OwnerNode` is a hexadecimal string, and not one of these: `issuance_destroy` has "1", and 346 nodes outside the fixtures have "d".

### (4) A created node leaves default fields out

- `issuance_create_no_max`: `NewFields` are `AssetScale`, `Flags`, `Issuer`, `MPTokenMetadata`, `Sequence`; there is no `MaximumAmount`, no `OutstandingAmount`, no `TransferFee`.
- Of 530 created issuances none has `OutstandingAmount` or `LockedAmount` in `NewFields`, and none has a 0 in `AssetScale`, `TransferFee`, `Flags` or `OwnerNode`. `Flags` itself is absent when 0.
- `authorize_holder`: `NewFields` are only `Account` and `MPTokenIssuanceID` (no `Flags`, no `MPTAmount`). 712 created tokens read, 48 of them with an `OwnerNode`.
- The exception is `escrow_finish_creates_token` (testnet): `MPTAmount` "9990" is in `NewFields`, see (10).
- The issuer holds no `MPToken`: none of 2,955 token nodes read on mainnet is the issuer's.

### (5) `DeliveredAmount` and `delivered_amount`

- After the fix: `payment_mint` (ledger 105827909): the stored metadata (binary, decoded) holds only `TransactionIndex`, `AffectedNodes`, `TransactionResult`. All 1,508 successful MPT payments read at 101852417 or later have no `DeliveredAmount`, nor have the 214 of the testnet.
- Source-read, rippled 3.4.1, `Payment.cpp`: `if (view().rules().enabled(fixMPTDeliveredAmount) && amountDeliver != dstAmount) ctx_.deliver(amountDeliver);`. So `DeliveredAmount` is stored only when less than `Amount` was delivered, which takes a partial payment. None of the payments read has `tfPartialPayment`.
- Before the fix: `payment_before_delivered_fix` (ledger 101491684): no `DeliveredAmount`, stored or served, but `meta.delivered_amount` `{ value: "1" }` is served, in the recorded ledger too. The node adds it to every successful payment.
- On all 1,542 mainnet payments (34 before the fix, 1,508 after) `delivered_amount` equals `Amount`.
- So the existing rule (`DeliveredAmount`, else `delivered_amount`, else `Amount`) gives the right amount on every payment read. C30(e) stood when this was written: a partial payment before the fix would serve `Amount`, and none was found. (2026-10-31, D9's review: such a payment now reads what moved, since a reprocess would otherwise write the wrong figure for good. Still none was found.)
- `DeliverMax`: all 7 MPT payments in the recorded mainnet ledgers carry it beside `Amount`.

### (6) The transfer fee is burned; MPT escrows exist

- `payment_transfer_fee` (`TransferFee` 589, `Amount` 1000000, `SendMax` 1062500): the sender's `MPTAmount` falls by 1005890, the destination's rises by 1000000, `OutstandingAmount` falls by 5890. The fall of `OutstandingAmount` is the sender's loss minus the delivered amount. The fee is on top of `Amount`, so `delivered_amount` is still 1000000, and 589 is 0.589%.
- It is one of two such payments found. Both are before the fix and of this issuance (the other is `4E1B4F24…`, ledger 99251715, `SendMax` 1005890 exactly).
- No fee on a redemption: `B6AAC525…` (ledger 99250393, same issuance, not recorded): `MPTAmount` falls by exactly `Amount`.
- `payment_holder_to_holder` (no `TransferFee`): two `MPToken` nodes and no `MPTokenIssuance` node.
- MPT escrows on mainnet: 59 successful EscrowCreate from ledger 102204932 on (three ledgers after TokenEscrow), and 5 EscrowFinish.

### (7) `EscrowFinish` of an MPT escrow charges the transfer fee

Yes, out of the locked amount.

- **Recorded, XRPL Testnet, `escrow_finish_transfer_fee` (ledger 19500967):** the issuance has `TransferFee` 100 and the `Escrow` has `TransferRate` 1001000000, `Amount` 10000. The destination's `MPTAmount` becomes 9990 (`PreviousFields` `{}`). The owner's and the issuance's `LockedAmount` are listed at 10000 and leave `FinalFields`. `OutstandingAmount` goes 100000 to 99990.
- **The fee is `amount` less what the destination got**, 10, as spec §4.2 says, and it is burned as in a payment. All 7 fee finishes of the 64 read on the testnet hold this. `0DE32182…` (ledger 19635652, `TransferFee` 10, not recorded) has 10000 to 9999, `OutstandingAmount` less 1.
- **Recorded, mainnet, `escrow_finish`:** no fee. Its issuance has no `TransferFee`, its `Escrow` has no `TransferRate`, the destination gets the whole `Amount`. All 5 mainnet finishes read are the same, and none of the 59 mainnet escrows read has a `TransferRate`. A fee finish on mainnet is therefore not observed.
- **Source-read**, rippled tag 3.4.1 (commit `336191572a5bf3e119f6bcdfbf9d60b25d30363d`), agrees:
  - `EscrowCreate.cpp` stores `sfTransferRate` on the escrow when the rate is not parity.
  - `include/xrpl/ledger/helpers/EscrowHelpers.h`, `escrowUnlockApplyHelper<MPTIssue>`, takes the lower of that locked rate and the issuance's current rate, and deducts the fee only when neither sender nor receiver is the issuer.
  - `unlockEscrowMPT` (`MPTokenHelpers.cpp`) takes the gross amount off the owner's and the issuance's `LockedAmount`, adds the net to the receiver's `MPTAmount`, and takes the difference off `OutstandingAmount`. Gross and net are separate only under `fixTokenEscrowV1`, enabled before TokenEscrow on both networks.
  - `fixCleanup3_4_0` changes only the rounding and is not enabled on mainnet (`config/amendments/xrpl.json`).

### (8) `LockedAmount` of the holder and of the issuance move together

- Create, `escrow_create` (`Amount` 277073): holder `MPTAmount` 954219 to 677146, holder `LockedAmount` to 277073, issuance `LockedAmount` to 277073, `OutstandingAmount` 954219 unchanged (677146 + 277073 is 954219).
- Finish, `escrow_finish` (`Amount` 277073): owner and issuance `LockedAmount` both 318073 to 41000, destination `MPTAmount` to 277073, owner `MPTAmount` and `OutstandingAmount` unchanged.
- Cancel, `escrow_cancel` (testnet, `Amount` 10000): owner and issuance `LockedAmount` both 10000 to absent, owner `MPTAmount` absent to 10000, `OutstandingAmount` 10000 unchanged, no fee.
- Counts on mainnet: 59 of 59 creates and 5 of 5 finishes move both by exactly the amount.

### (9) Enable ledgers

- **Mainnet**, read from the recorded ledgers (`EnableAmendment`, no `Flags`, `tesSUCCESS`; each `Amendment` is the SHA-512 half of the name):
  - 99226369, 2025-10-01T13:13:10Z: `MPTokensV1`, `14853FF2D09D198B576A531C50883C59D71474BA9072C1F5C0ED1DD57882B922`.
  - 101852417, 2026-01-27T22:20:10Z: `fixMPTDeliveredAmount`, `56B9F029DD5D65888DD9997D690ED1E2AF46B80B7C9B41FE87CE6AFD9B0E6D08`, and `fixTokenEscrowV1`, `E3B633906B8A9CA2BC9CB9DD832326001BDA02E5B336A640574E01ADD47058E3` (three other amendments are enabled in the same ledger).
  - 102204929, 2026-02-12T21:24:40Z: `TokenEscrow`, `90A1297408C5F76769626A94242BCBD671E3CCD02ABEF80D92D8C7D7623840D5`.
- **XRPL Testnet**, by walking the Amendments object back through `PreviousTxnID` on `clio.altnet.rippletest.net`, 31 `tx` requests, no bisection (these ledgers are not recorded):
  - 11119873, 2025-10-02T05:40:10Z: `MPTokensV1`, `2342309ED507B0C09ADAC864BD4934107AB8492766425C2F8A58C68E4082F27B`.
  - 14417665, 2026-01-28T05:46:52Z: `fixMPTDeliveredAmount`, `1A947AD28B6294DD3BDD0267D03BE459E5684C9633787ACDD177D726FEBE655A`, and `fixTokenEscrowV1`, `98EB534BEBF9EE8DAFBC87A7CADA4BADA8B8D5FC1D2D17150F00BD7C113A2C6C`.
  - 14854913, 2026-02-13T05:52:31Z: `TokenEscrow`, `A1DBA3188B75481A0FD9B045A7F3F339C0A5FF256330428BF43D27BDEBF49F49`.
  - `DynamicMPT` and `MPTokensV2` are not in the object at ledger 21965960.

### (10) Other shapes a parser meets

- A deleted node carries `FinalFields` and no `PreviousFields`: 145 of 145 `MPToken`, 165 of 165 `MPTokenIssuance`. `unauthorize_holder` has `Account`, `Flags` 2, `MPTokenIssuanceID`, `OwnerNode` and no `MPTAmount`. `issuance_destroy` has `OutstandingAmount` "0", and the holder's token stays behind.
- A lock changes `Flags` only: `issuance_set_lock_holder` lists `{ Flags: 2 }` and keeps `MPTAmount` "45000000" in `FinalFields`, which is what spec §4.2's `amount` reads. `issuance_set_lock_all` has one MPT node, the issuance (`Flags` 122 to 123, `OutstandingAmount` "100"). `B406BE4A…` reverses it.
- An `MPTokenIssuanceSet` with neither flag can succeed and change nothing: 4 read (`92A7A0B4…`, ledger 103174162, not recorded), no MPT node in the metadata.
- A Batch inner transaction has `tfInnerBatchTxn` (0x40000000) in `Flags`, so a flag test must mask: `clawback_partial` has 1073741824, and a lock inside a Batch (`E07F200F…`, ledger 107785580, not recorded) has 1073741825. 78 inner transactions read; none of the 40 outer ones has an MPT node.
- Delegated: 5 read on mainnet (`Delegate` set; 1 MPTokenAuthorize, 2 MPTokenIssuanceSet, 1 create, 1 destroy). None is a case, and none is in the recorded ledgers (the delegated count of `balance-changes.parser.spec.ts` stays 8).
- An `EscrowFinish` by the destination may create its `MPToken`: `escrow_finish_creates_token` (testnet, ledger 15923872) is a `CreatedNode` with `Account`, `MPTAmount` "9990", `MPTokenIssuanceID` in `NewFields`. The only `CreatedNode` read that holds an amount.
- Metadata keys are not only XLS-89's: `7D7E5FD3…` (ledger 99248617, not recorded) has `Name`, `Symbol`, `Description`, `Image`, `Website`. `A5FD19877C…` (99249196, not recorded) starts like JSON and does not parse. `issuance_create_raw_metadata` is a URL as text.

## Not found

Every case name of the plan is recorded. `escrow_cancel` is the one case mainnet does not have: of the 59 MPT escrows read there, 5 are finished, the 16 asked with `ledger_entry` are alive, and the other 38 have `CancelAfter` from 2027 on. It comes from XRPL Testnet.

Not case names, but shapes no read transaction shows, so a test that needs one uses a named synthetic:

- A stored `DeliveredAmount` on an MPT payment: none of 1,542 on mainnet or 214 on the testnet is a partial payment.
- A fee payment after fixMPTDeliveredAmount: the two on mainnet are before it, and the testnet's 63 holder-to-holder payments have no fee.
- A clawback that took less than it asked: taken equals `Amount` on all 33 on mainnet and all 13 on the testnet.
- An `EscrowFinish` to the issuer: none of the 69 finishes read.
