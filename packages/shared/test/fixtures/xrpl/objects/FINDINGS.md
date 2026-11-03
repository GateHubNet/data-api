# XRPL ledger object fixtures: findings

Recorded 2026-10-29 from `wss://s2.ripple.com` (rippled mainnet, Clio; network id 0; validated head 107973016) with `--txs`: 22 ledgers, 22 transactions (2.02 MB gzipped, largest 428 KB, ledger 107972102), the 19 cases of `manifest.json` and three supporting transactions (below). Every fact says how it was checked. The checks were made with throwaway scripts (not in the repository) on the recorded ledgers, on scan files, and on `wss://s1.ripple.com` (`tx` with `binary: true`, `account_tx`, `account_objects`). `src/ingest/object-fixtures.spec.ts` pins what each case is for; this page is what the parser tasks rely on. Questions (4) and (5) are Xahau's and are answered in `xahau/objects/FINDINGS.md`.

## Where the cases came from

- **Scan.** One script walked 4,998 validated ledgers of `s2` (107967129 to 107972126, 2026-10-28T22:18Z to 2026-10-29T03:52Z) with `ledger { transactions: true, expand: true }`, one request in flight, 150 ms apart, and kept every Escrow, Check, PaymentChannel and DelegateSet transaction and every transaction with a `Delegate` (after the first two of each type, result, account and delegate, it kept only the counts). It met 1 successful EscrowCreate, 2 successful EscrowFinish (5 more failed `tecNO_TARGET`), 144 EscrowCancel (all `tecNO_TARGET`), 1,539 successful CheckCreate, 1,089 successful and 6,412 `tecPATH_PARTIAL` CheckCash, 1,801 CheckCancel, 6 PaymentChannelClaim, and no PaymentChannelCreate, PaymentChannelFund or DelegateSet. Only checks are common; every other kind came from account histories.
- **Account histories** (`account_tx`, one request in flight, on `s1`): `rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR`, the destination of most live channels (3,200 rows: creates, a fund with `Expiration`, claims, a close request, a close by the destination, renews, a close of an expired channel); `rPw6JAdM9BGwH4y4LxJQBDybaGNhFLCspU`, a bot that finishes other people's escrows (2,301 escrow transactions; the Escrow node of each finish names the `EscrowCreate` in `PreviousTxnID`); the token-escrow testers `rsQYjimpnfyYuebLYDhkCfaMExqESap8jL`, `rwEPtzveRSB2eb7Yp1PPxSPLFyrcp2oa4j`, `rrhiytwQhbFZ8UvxX4RT1s4y42JyLjDehR` and `rHXgaJLpjDe4jsAiF8atNrRfS6eYrjPYPB` (they create conditional token escrows and cancel them: 4,234 conditional EscrowCreate, none finished); `r3pzUULRxwRF1m5DjBWMk6FMEMwViRMCN5` (timed XRP escrows); `rnt8PbBFT7idcLyj9PNgxjZi9Z1RiRX3QL` (10,000 rows) and its `Delegate`, found with `account_objects`. In all 12,880 escrow transactions were read (4,597 EscrowCreate, 2,392 EscrowFinish, 5,891 EscrowCancel). The earliest token EscrowCreate among them is in ledger 106126120.
- **Recorded before, recorded again here** so that the object cases live in one directory: the XRP cash `A0EE5458…` (was in `xrpl/recorded/107671568`), the CheckCreate with `InvoiceID` and `Expiration` `CCDBCADF…` (`xrpl/amm/107698980`), the EscrowFinish without Fulfillment `92EC1EA8…` (`xrpl/recorded/107670360`) and the delegated Batch inner `8A57855B…` (`xrpl/amm/107699656`).
- **Supporting transactions** (in the manifest's `txs`, not cases): the token cashes `3ABD7BA6DA173F446AFA31C5C2D4EA51FC73A3BDA6E9ED7BBC557A215E33B330` (ledger 107703707) and `A075E757D0E6E283ABB6CD7ED751A412D4B1DC14C6F5DE616819C7D6579EC63C` (107711512) for finding 1, and the creation of the channel of `channel_claim`, `E8A8466AF9E1E5E6339F1EAC64A9B8AD7AB4BE42613605511EDC80E1FCD34127` (107624182), for finding 6.

## Findings

### (1) DeliveredAmount in the metadata of an XRP cash and of an issued-token cash

An XRP cash has no `DeliveredAmount` in the metadata that the ledger stores; an issued-token cash has one, equal to the amount delivered.

- XRP cash `A0EE5458F913A115FC3BA022BDC227FBBCE81236DDF4A6B2BEA06BAEFAA8C1CE` (ledger 107671568, `Amount` "933622827"): `tx` with `binary: true` on `s1`, decoded with ripple-binary-codec, gives the metadata keys `TransactionIndex`, `ParentBatchID`, `AffectedNodes`, `TransactionResult`: no `DeliveredAmount`. The JSON that the node serves (and the recorded ledger) carries a lowercase `delivered_amount` "933622827" that the node adds; it is not a stored field. The same holds for all 447 successful XRP cashes of the scan: `delivered_amount` always, `DeliveredAmount` never.
- Token cash `3ABD7BA6…` (ledger 107703707; `Amount` 0.438027 RLUSD, issuer `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`): the stored (binary) metadata has `DeliveredAmount` `{value: "0.438027", currency: 524C555344000000000000000000000000000000, issuer: rMxCKb…}`. `A075E757…` (ledger 107711512, 0.389373 RLUSD) is the same. In all 642 successful token cashes of the scan `DeliveredAmount` is present and equal to the transaction's `Amount`.
- So a reader takes the cash's delivered amount in this order: the stored `DeliveredAmount` when the metadata has one (every token cash; the Xahau `DeliverMin` cash too), else the served `delivered_amount`, else the transaction's `Amount` (an XRP cash on XRPL stores none; its `Amount` equals the served `delivered_amount`). Whether a `DeliverMin` cash on XRPL stores `DeliveredAmount` is not known here: none was found (`check_cash_deliver_min`, under "Not found"). The Xahau set has one, and its metadata has `DeliveredAmount` "1000000".

### (2) Issued-token escrow on XRPL: whose trust line moves at create and at finish

At create the sender's trust line moves; at finish the destination's. The issuer has no node of its own beyond its owner directory.

- Create `3D7F58900F76F6B50D7B5BB1988D9E3C4E33744928B14DE1106848FFA9A3343C` (ledger 107945438; 75000 XRB, issuer `rD9ixf7RRUKuKVFTsZa3fZGAN6HtNziPKa`, sender `rfd4xkXuigdGJV2XYkbosFzBQaLsc6M8Vm`, destination `rHiwfnKJCwNePaTj8HmEYCx8G5NCsSEJSt`): one ModifiedNode `RippleState`, the sender's (it is the low side; `Balance` 10000000 to 9925000 from the low side: the sender's holding falls by 75000), and one CreatedNode `Escrow`. The rest are the sender's `AccountRoot` (fee, `Sequence`, `OwnerCount`), the destination's `AccountRoot` threaded only (no fields), and three `DirectoryNode` (the sender's, the destination's and the issuer's: the escrow's `IssuerNode`). The issuer's `AccountRoot` is not in the metadata.
- Finish `375202E930018352EA63F82A1DCAF7795916DC5117C74D013119E67955C157DA` (ledger 107967068; `OfferSequence` 107945427, `Owner` the sender, sent by the finisher bot with a ticket, `Sequence` 0): one ModifiedNode `RippleState`, the destination's (it is the high side; `Balance` -248700.70388715 to -323700.70388715 seen from the issuer side: the destination gains 75000), and one DeletedNode `Escrow` (`IssuerNode` "0", `PreviousTxnID` the create). The sender's trust line is not in the metadata; its `AccountRoot` is (`OwnerCount` down by one).
- So the spec's expectation holds: the sender's line at create, the destination's at finish, the issuer only as the other end of the same `RippleState`. Of the 426 successful token finishes read, 367 have an escrow owner other than its destination and 59 an owner equal to it (the owner receives the tokens back into the same line; `C0D3B2A771E55A2D82891E1F8747538D2E1AA8DABB7A0D8513A361B87280E2AF`, ledger 107968873, is one, not recorded).
- Cancel (`escrow_cancel`, ledger 106179366): the owner's line gets the amount back; no other line moves.

### (3) Which transaction types delete a Delegate besides DelegateSet

Not observed on the network; the answer is the documentation's, read on 2026-10-29 through a fetch tool that summarises pages (so the wording is the tool's). xrpl.org's Delegate page says that a `DelegateSet` with no permissions deletes the entry, that deleting the delegating (owner) account deletes its Delegate entries, and that deleting the `Authorize` (delegate) account removes the entry as well; it does not name the transaction that deletes an account, which is `AccountDelete`, and says a Delegate entry does not block it. No `AccountDelete` that deleted a Delegate was found: the only delegation found (`rnt8Pb…` to `rw2X2G…`, `account_objects` of both on 2026-10-29) is alive, and the one AccountDelete after the amendment in the fixtures (`8F2DCA9443…`, ledger 107671593, in `xrpl/recorded` and `xrpl/account-state`) has no Delegate node in its metadata. Task 4 builds a synthetic `AccountDelete` that deletes a `Delegate` (`delegate_set_empty` is also under "Not found").

### (4) and (5) are Xahau's

See `xahau/objects/FINDINGS.md`.

### (6) A channel's first claim carries PreviousFields.Balance "0"

Yes. In the history of `rLggTEwmTe3eJgyQbCSk4wQazow2TeKrtR` 23 of 23 channels that have a creation and a claim have `PreviousFields.Balance` "0" (a string; XRP channels only on XRPL) on their first claim. The created node has no `Balance` in `NewFields` (0 of 23 do), so that "0" is the only place the zero shows. `channel_claim` (ledger 107641123, `Balance` "32185") is one: channel `E22CCE8FA636C8BDF1C3C4AA17FD604B8FDE268E4F6BF9022B5336536F5B69EA`, created by `E8A8466A…` (ledger 107624182). Task 11's `claims` can therefore count the events whose channel node's `Balance` rose, first claims included. On Xahau the created node does carry `Balance` "0" (see its file).

### (7) The 12 granular permission values of xrpl.org's "Permission Values" (read 2026-10-29)

`https://xrpl.org/docs/references/protocol/data-types/permission-values`. Transaction-type permissions are the type's number plus 1 (1 to 65536; `Payment` is 0, so 1); 0 is full permissions and cannot be delegated; the granular ones are 65537 to 65548. The names and numbers were checked in the page's HTML; the transaction type each narrows was read from the page's table by the fetch tool and agrees with the page's sentence that "TrustlineAuthorize" grants only TrustSet transactions that authorize trust lines.

| Value | Name | Narrows |
| --- | --- | --- |
| 65537 | `TrustlineAuthorize` | `TrustSet` |
| 65538 | `TrustlineFreeze` | `TrustSet` |
| 65539 | `TrustlineUnfreeze` | `TrustSet` |
| 65540 | `AccountDomainSet` | `AccountSet` |
| 65541 | `AccountEmailHashSet` | `AccountSet` |
| 65542 | `AccountMessageKeySet` | `AccountSet` |
| 65543 | `AccountTransferRateSet` | `AccountSet` |
| 65544 | `AccountTickSizeSet` | `AccountSet` |
| 65545 | `PaymentMint` | `Payment` |
| 65546 | `PaymentBurn` | `Payment` (needs `fixCleanup3_4_0`; the page advises not to delegate it before that) |
| 65547 | `MPTokenIssuanceLock` | `MPTokenIssuanceSet` (needs `MPTokensV1`) |
| 65548 | `MPTokenIssuanceUnlock` | `MPTokenIssuanceSet` (needs `MPTokensV1`) |

Note the spelling `AccountEmailHashSet`. The delegation found lists its `PermissionValue`s as the names "OfferCreate" and "OfferCancel": the node serves transaction-type permissions as names in JSON.

### (8) A delegated Batch inner transaction and an MPT escrow on mainnet

- A delegated Batch inner transaction exists: `delegated_batch_inner`, `8A57855B074280D7783182F3556BADD92246252E6EFFE0FD7E807E0B200FC2D8` (ledger 107699656): an OfferCreate by `rnt8PbBFT7idcLyj9PNgxjZi9Z1RiRX3QL` with `Delegate` `rw2X2GFePFiLDdcQw6iELFfUEw1hPqAGcK`, `Fee` "0", `Flags` 1073807360 (`tfInnerBatchTxn` and `tfPassive`). Its outer Batch is `26BDDAD0…`, sent by the delegate in the same ledger; the delegate is not in the inner transaction's metadata. The scan saw 255 delegated transactions in 792 ledgers and 432 in the next 3,300, all this one pair. The delegator's last 10,000 rows hold 9,907 delegated OfferCreate and 10 delegated OfferCancel, all `tesSUCCESS`, and 34 Payments that are not delegated. `check_cash_amount` is also a Batch inner (`Fee` "0", `tfInnerBatchTxn`, `ParentBatchID`), not a delegated one.
- An MPT escrow does not exist in the data: no `mpt_issuance_id` amount in any of the 12,880 escrow transactions and no `MPToken` node in their metadata. Under "Not found".

## Not found

Each is built synthetically in the test that needs it (the later tasks name it `synthetic-…`).

- `escrow_create_ticket`: none of the 4,597 EscrowCreate read has `Sequence` 0 and a `TicketSequence`. (Tickets show up in the finisher bot's EscrowFinish, not in creates.)
- `escrow_finish_fulfillment`: none of the 2,392 EscrowFinish read has a `Fulfillment`. All 4,234 conditional EscrowCreate are token escrows of the cancelling testers (`escrow_create_conditional` is one, with `FinishAfter` and `CancelAfter` and an issued token); no conditional XRP escrow was found.
- `escrow_create_mpt`: see finding 8.
- `check_cash_deliver_min`: none of the 7,501 CheckCash of the scan (1,089 successful, 6,412 `tecPATH_PARTIAL`) has a `DeliverMin`, nor has the recorded ledger 107671568 (all 31 CheckCash there use `Amount`; the DeliverMin fields there belong to a Payment and to the inner Payments of Batches). A real DeliverMin cash is in `xahau/objects` (`check_cash`, `11B73A14…`, ledger 12064524); the parsers are shared.
- `check_cancel_third_party_expired`: all 1,801 CheckCancel of the scan are by `rPP3R33zpehB5hTy2jSYZek5ntq3HQym68` for its own checks (`check_cancel_source` is one). No cancel by an account that is neither source nor destination was seen. (A third party did cancel escrows after `CancelAfter`: `escrow_cancel`.)
- `delegate_set_replace`: the only DelegateSet found is `delegate_set_create`, and that Delegate has not changed since (its `PreviousTxnID` is that transaction). There is no DelegateSet in the 4,998 scanned ledgers, none in the delegator's 10,000 latest rows, and none in the first 800 rows after the amendment (`PermissionDelegationV1_1`, enabled in ledger 107524865 on 2026-10-08 according to a delegation checker's README; `feature` shows it enabled) of four large issuers. An empty-permission DelegateSet deletes the entry, so it can only be found in transactions, not in the state.
- `delegate_set_empty`: as `delegate_set_replace` (an empty-permission DelegateSet deletes the entry, so it can only be found in transactions).
- `delegated_payment`: every delegated transaction seen is a successful OfferCreate or OfferCancel of the one pair above; none is a Payment and none a `tec`.
- `delegated_tec`: as `delegated_payment`: no delegated transaction with a `tec` result was seen.
