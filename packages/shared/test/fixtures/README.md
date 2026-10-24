# Ledger fixtures

Raw ledgers used by parser, ledger-writer and API tests. Load a directory with `FixtureLedgerSource.fromDir(dir)`
(`src/ingest/fixture-ledger-source.ts`); it reads `<index>.json`, `<index>-<label>.json` and `<index>.json.gz` files and
ignores everything else in the directory (`manifest.json`, `server_info.json`, `README.md`, ...).

| Directory              | Contents                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `xrpl/ripple-mock/`    | The 54 mock ledgers of the original Ripple Data API (ISC); see its own `README.md`.     |
| `xrpl/recorded/`       | Mainnet ledgers recorded from a public node (see below).                                |
| `xrpl/amm/`            | Mainnet AMM transactions, one ledger per named case (see below).                        |
| `xrpl/account-state/`  | Mainnet changes of account flags, trust line settings and an AccountDelete.             |
| `xahau/recorded/`      | Xahau mainnet ledgers recorded from a public node (see below).                          |
| `xrpl/unl/`            | Validator lists of the XRPL default publishers, as served (see "UNL lists").            |
| `xahau/unl/`           | The validator list of the Xahau default publisher, as served (see "UNL lists").         |
| `xrpl/network-state/`  | Answers of an XRPL node for the validators worker's ledger state (see "Network state"). |
| `xahau/network-state/` | The same from a Xahau node (see "Network state").                                       |

## Recorded fixtures

Each `<index>.json.gz` is the full `result` of the rippled API v1 request
`{ command: 'ledger', ledger_index, transactions: true, expand: true }` (so the ledger itself is under `ledger`, next to
`ledger_hash`, `ledger_index` and `validated`). No `api_version` is sent. Every recorded directory also holds:

- `server_definitions.json`: the node's `server_definitions` result (bundled as `config/definitions/<network>.json`, the
  binary-codec fallback of the network profile; copy it there again after re-recording).
- `server_info.json`: the node's `server_info` result at recording time.
- `manifest.json`: endpoint, validated head, number of ledgers scanned, which wanted types were found (ledger and
  transaction hash) and which were not, and the recorded `ledgers`. `--txs` runs add a `txs` map (hash to
  `{ledger, type, result}`). `xrpl/amm/` also has a hand-written `cases` object (case name to `{ledger, hash, type, note}`).

### Re-recording

```bash
pnpm --filter @gatehub/data-api-shared exec ts-node scripts/record-fixtures.ts \
  --network xrpl|xahau --endpoint <wss url> --out test/fixtures/<network>/recorded \
  [--ledgers 1,2,3] [--txs HASH,HASH] [--want TypeA,TypeB --scan N] [--delay-ms 75] [--any-result]
```

(`pnpm --filter @gatehub/data-api-shared record:fixtures -- <same args>` is the same command.)

`--want` walks back one ledger at a time from the validated head and keeps a ledger only if it holds a wanted
`TransactionType` that has not been found yet. A type counts as found on its first `tesSUCCESS` transaction (pass
`--any-result` to accept any result code). The scan stops when every wanted type is found or `--scan` ledgers have been
checked. Requests are sequential, with a pause between ledgers, and throttling by the server is waited out.

`--txs` looks up each transaction with `tx`, takes its `ledger_index` and records that whole ledger like `--ledgers`
does. A ledger that holds several of the hashes, or that `--ledgers` already recorded, is fetched once. The run stops
naming the hash when the node answers `txnNotFound`, when the transaction is not in a validated ledger yet, or when the
recorded ledger does not contain it. The manifest gets a `txs` map (hash to `{ledger, type, result}`). What an earlier run
left in the manifest of `--out` is merged in, so adding one hash to a directory keeps the rest: its `cases` (hand-written
case names), its `txs` and its `ledgers` (the last two only while the `<index>.json.gz` files are still there). The other
keys describe the current run.

### XRPL (`xrpl/recorded/`)

Recorded 2026-10-15 from `wss://s2.ripple.com` (rippled mainnet, network id 0): validated head 107671609, 3000 ledgers
scanned (107668610 to 107671609), 9 ledgers kept (748 KB gzipped, largest 316 KB).

`--want AMMCreate,AMMDeposit,AMMWithdraw,NFTokenMint,NFTokenAcceptOffer,AccountDelete,CheckCash,TicketCreate,Clawback,EscrowFinish,PaymentChannelClaim --scan 3000`

| TransactionType    | Ledger    | Transaction                                                        |
| ------------------ | --------- | ------------------------------------------------------------------ |
| AMMCreate          | 107671317 | `6F152B6ED9514109B5CA4DA5A1050A5C57237BA413A12E46A7CC6E1F8FBCE977` |
| AMMDeposit         | 107671558 | `83F332E0141EF2AD30427A8476FFD8469D678321F58E649F30761A862D880A4B` |
| AMMWithdraw        | 107671499 | `4F2B0756C721F7DAE0016F3B7481601377241BE63B8C5A1BD90F4ECA732D8CA8` |
| NFTokenMint        | 107671538 | `7D16D6C749CAB260C906BEC2D9CF9B37F7D1D36F26421873CF838C9BCDF056AD` |
| NFTokenAcceptOffer | 107671591 | `423839F3B288D53874DAECE9AE3ACCE2A23E20E2C16E5DA594F425907D9E2052` |
| AccountDelete      | 107671593 | `8F2DCA944394B29981E24DDD6C46192C404D90F7F5FC4EAB6813B0AFD7751A2D` |
| CheckCash          | 107671568 | `A0EE5458F913A115FC3BA022BDC227FBBCE81236DDF4A6B2BEA06BAEFAA8C1CE` |
| TicketCreate       | 107671607 | `A6D2AB0623B1874F35E0884BC42A82A18389627317EE1A93E61A4CF0B43E915B` |
| EscrowFinish       | 107670360 | `92EC1EA8B38B7242F07591AB4BF1AAB5E6B2E3015CE6E15AAAADAC05E6B74046` |

**Not found** within the 3000-ledger window (no successful transaction of that type): `Clawback`,
`PaymentChannelClaim`.

The first attempt used `wss://xrplcluster.com`, as planned. Its quota (2000 units per 10 s and 10000 per 60 s) allowed
only about 12 expanded ledgers per minute, so that run was stopped at 600 of 3000 ledgers and the whole scan was redone
on `wss://s2.ripple.com`, which has the same mainnet data and a much higher limit.

### XRPL AMM cases (`xrpl/amm/`)

Recorded 2026-10-17 from `wss://s2.ripple.com` (validated head 107717584) with `--txs`: 16 ledgers, 0.8 MB gzipped (largest
125 KB). Each ledger holds one named case. `manifest.json` has them under `cases.<name>` as `{ledger, hash, type, note}`
(the note says which pool and what moved); later AMM tests look a fixture up by that name. The hashes were found with
`account_tx` on busy pool accounts (about 39,700 rows over 8 pools in full and 65 more pools by their first 400 rows).

| Case                               | Type        | Ledger    | Transaction                                                        |
| ---------------------------------- | ----------- | --------- | ------------------------------------------------------------------ |
| `swap_payment_xrp_iou`             | Payment     | 107694747 | `52E2AD5B382D4588BECF6A743E7AE5C84D49A5C06968EC7700E8333BF41E1C60` |
| `swap_offercreate_xrp_iou`         | OfferCreate | 107699656 | `5081561D02260B321E16B9C3EF2840D6C5D32E6D62C74DADD7428F40C73D2793` |
| `swap_iou_iou`                     | Payment     | 102186243 | `B9C56D941C726140DCDE385A5045EDF976745F434153EA49908AAE92969B1469` |
| `payment_two_pools`                | Payment     | 107636673 | `2C9538843C61FE4120577EDCD885C9B4E6AC6694C9DF3603528B81A2D9FC084A` |
| `payment_pool_and_book`            | Payment     | 107713744 | `8014250A4FB1AC8859C4743090B7A905F2738253C010B968E272368A3FE59900` |
| `offercreate_autobridged_pool_leg` | OfferCreate | 107698980 | `F9F304F7B20FA2B1A340C1AB5DD0D6F410A50E80444EE698A47D556BA78E34FC` |
| `deposit_two_asset`                | AMMDeposit  | 107703707 | `20254F31198DE60948CB0488464D9D9E55B262486D5C366FD6046374254ADF25` |
| `deposit_single_asset`             | AMMDeposit  | 107698848 | `94E38B2BCCA96997BCEC32925AEB289D35EC9FD67977995102D91A7E3DD71FEF` |
| `withdraw_two_asset`               | AMMWithdraw | 105257303 | `781C5A2707D3A3E9BB00B483A8719345A6ECF0E5532E0CB5FA4016E1D5D6A832` |
| `withdraw_single_asset`            | AMMWithdraw | 107711512 | `2D6FF646176D364EAD12395D67CCA6D459E1875F537D035D9B10B7754ACA07A3` |
| `withdraw_all_deletes_pool`        | AMMWithdraw | 100132150 | `B44F14E085567F8C25DD20456FCAD9B0A289BA2EA2AB3469D6F29E582059F63F` |
| `vote`                             | AMMVote     | 107644916 | `EF35220095FC32B7036D130A460CFB31B80BAF973C0C7F7A9812B0665E33701B` |
| `bid`                              | AMMBid      | 106084525 | `2D66C6FD02977F96126FB352AAD691CA556790DBF71E0CDF3B701E18A49B9427` |
| `create`                           | AMMCreate   | 107612573 | `B9A146300E7755D109BF92B6B51725B8C45BA1CCFB6683C0E01DA679B2FB0675` |
| `lp_token_transfer`                | Payment     | 93663334  | `6C6B9070EF68F9BC7777C018DC85596B40C531DBB29FA0E9C49B5964DF75B96B` |
| `swap_issuer_transfer_rate`        | Payment     | 107506489 | `CB1B7721CCC2C842B86A178A26BF50160F57CEC9E95291A9C5349071B89C3822` |

**Not found** (later tasks use a synthetic case for each; every AMM transaction seen was `tesSUCCESS`, 422 distinct ones):

- `deposit_lp_token`: no `AMMDeposit` with `tfLPToken` (`LPTokenOut` and no `Amount`). Deposits seen: 182 `tfTwoAsset`, 92
  `tfSingleAsset`, 1 `tfOneAssetLPToken` (ledger 107682275, `E510B26FCD04032EF8ED07A9721396123DC88062F7A5ACB4D5B66AB9B3633EC6`).
- `clawback`: no `AMMClawback`. The RLUSD issuer allows clawback, so the XRP/RLUSD and RLUSD/USDC pools were searched
  first (2,000 rows each, ledgers 107672830 to 107717205 and 97405106 to 107696344).
- `delete`: no `AMMDelete`. It is only sent when a withdraw-all cannot remove every trust line, which needs a very large
  number of LP holders. The one deleted pool found was deleted by `AMMWithdraw` `tfWithdrawAll` (`withdraw_all_deletes_pool`).

**`swap_iou_iou`: the pool's `AccountRoot` (the one with `AMMID`) is not in the metadata, and neither is the `AMM` node.**
Pool `rfWfhoLj3LiaBpoxus3h7pEF8jXDMtyGqb` (RLUSD/USDC) is named only by two `ModifiedNode` `RippleState` nodes, one per
asset. In each, `LowLimit.issuer` is the pool, `HighLimit.issuer` is the asset's issuer, both limits are `0`, and `Flags` is
`16842752` (0x01010000): `lsfAMMNode` (0x01000000) plus `lsfLowReserve` (0x00010000). When the pool is the high account the
reserve bit is `lsfHighReserve` (0x00020000). The pool's holding is the `Balance` of those lines (USDC 26166.00356770683 to
26143.78888602195 and RLUSD 26084.79732331936 to 26106.99384217401). This is the rule, not an exception: all 1,852
successful `Payment` and `OfferCreate` transactions in that pool's 2,000 rows have the two `lsfAMMNode` lines and none has the
pool `AccountRoot`; its 145 deposits and withdrawals have the `AMM` node and no pool `AccountRoot` either. For the XRP/IOU
pools the `AccountRoot` is in every swap that crosses the pool (1,982 of 1,982 XRP/RLUSD, 1,998 of 1,998 XRP/USDC, 1,992 of
1,992 XRP/USD GateHub). Pool detection by `AccountRoot`-with-`AMMID` or `AMM` node (spec section 2.1) therefore finds no
pool in an IOU/IOU swap; the `lsfAMMNode` flag on a `RippleState` does.

**Which side of an `lsfAMMNode` line is the pool:** the side whose reserve bit is set. `lsfLowReserve` (0x10000) means
`LowLimit.issuer`, `lsfHighReserve` (0x20000) means `HighLimit.issuer`. In the fixtures the bit always points at the pool
(`swap_iou_iou` has 0x01010000 with the pool low; `payment_two_pools` and `create` have 0x01020000 with the pool high).
This stays unambiguous for an IOU/IOU pool whose two assets share one issuer, where the two lines name the same issuer
besides the pool and intersecting the accounts of the two lines could not tell them apart. A `DeletedNode` line has no
reserve bit left (`withdraw_all_deletes_pool` has Flags 0x01000000), so for a deleted line the pool has to come from the
`AMM` node or the `AccountRoot` of the same transaction.

Other facts the fixtures show:

- Single-asset XRP deposits and withdrawals (`deposit_single_asset`, `withdraw_single_asset`) have the `AMM` node, the pool
  `AccountRoot` and the LP's LP-token line, but no `lsfAMMNode` line. `vote` has only the `AMM` node and the voter's
  `AccountRoot`; `bid` the `AMM` node, the bidder's `AccountRoot` and LP-token line. The `bid` transaction lists `Asset` USD
  and `Asset2` XRP, so the transaction's asset order is not the canonical pair order.
- `withdraw_all_deletes_pool`: the `AMM` node, the pool `AccountRoot` and the pool's trust line (Flags 0x01000000, no
  reserve bit) are `DeletedNode`. `create`: the same three are `CreatedNode`.
- `lp_token_transfer` has no `AMM` node, no pool `AccountRoot` and no `lsfAMMNode` line, only two LP-token `RippleState`
  nodes with the pool as issuer. The pool detection above sees no pool here; the movement shows in `balance_changes` only.
- `swap_issuer_transfer_rate`: the GateHub USD issuer has `TransferRate` 1002000000. The pool's USD line moves by 83.28354047857
  and the receiver's by 83.11730586684 (ratio 1.002), so the pool delta, not the amount in the transaction, is what the pool
  paid. Same on the paying side for Bitstamp USD (0.15%), ledger 107458137,
  `80AF066F79D7B856A7CCF1593915540A92657365013D97F4843FAB1E54700357` (not recorded).
- `account_tx` on a pool also lists `OfferCreate` and `Payment` transactions that trade its LP token (the pool is the issuer
  of an amount in those nodes), for example ledger 107484355, `CABF2BFA0EEA7F5C24685A93B5B04B05060CBF29D1F316A497EE4C3519B9D875`
  and ledger 107634980, `170A96F97CD65E85398C734FEA8391D45B2DB7FCFBC2CFB1102DA520C2066F7E` (neither recorded).

Other modes seen but not recorded (record with `--txs`): `AMMWithdraw` `tfLPToken` ledger 107682281
`E0D5DD1B0CCEE179A2C41DDAAB3CF70A84983FBDE514E974BFE7BC04939DF09D`; `tfOneAssetLPToken` ledger 101884996
`12DD6932C470A1219A1FC3A7776426C264CBBB699AADFD956E4DA84ADFD921D4`; `tfOneAssetWithdrawAll` ledger 107678106
`A8502C7ED44D665D5DFA4D03D7971CB3ADED89296C0E775D75128B815D795E5D`; `tfWithdrawAll` that leaves the pool, ledger 107708397
`06B00160DC77AC10A22EEA4CA7DF8DF8F3A5EFFD548C9674EB062CCD9C86C998`.

**AMM enablement ledger: 86795265**, closed 2024-03-22 20:11:41 UTC. The `EnableAmendment` pseudo-transaction for `AMM`
(amendment id `8CC0774A3BF66D1D22E76BBDA8E8A232E6B6313834301B3B23E8601196AE6455`, the first 32 bytes of SHA-512 of "AMM") is
transaction `75F52BB86416717288999523063D54E24290EFEA2E99DF78E80A12BD1C8FAC99`; the ledger hash is
`438E0988A35F030ED73C4F3F7C02981485599ABAA9913805EDD7D2B970FD4B33`. Found by bisecting `ledger_entry` on the `Amendments`
object (`7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4`) at the flag-adjacent ledgers (sequence 256k + 1)
between 2024-03-12 and 2024-03-30: 54 enabled amendments without AMM at ledger 86795009, 55 with it at 86795265. 20 requests.

### XRPL account state cases (`xrpl/account-state/`)

Recorded 2026-10-24 from `wss://s2.ripple.com` (validated head 107873207) with `--txs` and `--delay-ms 500`: 7 ledgers (893 KB
gzipped, largest 305 KB). The API's account state history tests (`apps/api/test/account-flags.e2e-spec.ts`, seed
`xrpl-account-state`) read them: each change comes with a ledger in which the same account changed before, so a test sees the
flags before and after it. The hashes were found with `account_tx` on each account; the `cases` of `manifest.json` name them.

| Case | Ledger | Transaction | What the account root does |
| --- | --- | --- | --- |
| `account_created` | 93663329 | `4DCBF02D75CF484B385F667B75A8871B843E6C9E8C8D483248693A5A6E75F0A2` | A Payment creates `rKqSPjN6okYt7iPk3xzWvuW9oN1Nk7vSUV`, no flags |
| `accountset_sets_flag` | 93663330 | `25D5F48CFECC3987AC6402778D123E9955E4340E8FC30156657A0C4153AD1E10` | AccountSet `SetFlag` 8: DefaultRipple (0 to 0x800000) |
| `setregularkey_then_disable_master` | 93663334 | `DD0B4FC1AA4D8A4E0FBEDFD591828A932FE6111F87FD5DA71CC25214075FCF42` | SetRegularKey sets PasswordSpent, then AccountSet `387FDEDC…` sets DisableMaster (0x910000) |
| `password_spent_before` | 107872956 | `F96ADF5D4D59B6BA82E9FA85EF266948FBE461A5220B2CB1C889A36F4837DBB4` | A Batch of `rheEvN3wAWbnPwnnsisiJzUqqKqoUC14tw`, which has PasswordSpent (0x10000) |
| `payment_clears_password_spent` | 107872958 | `53E513967FF6114B8D7131E6E882D41A457692E7D05CB363270D55F30F385B2D` | A Payment of XRP to it clears PasswordSpent (0x10000 to 0): a flag changed by another type |
| `before_account_delete` | 107670694 | `EE8547C7070DFB9C2249EAF693B77C1253858317F5132F058EEE267199F8828C` | The last change of `r3CgerzsDtZhh3ejvDjZJUKqXqRVWQcnNC` before it is deleted |
| `account_delete` | 107671593 | `8F2DCA944394B29981E24DDD6C46192C404D90F7F5FC4EAB6813B0AFD7751A2D` | AccountDelete: the account root is a `DeletedNode` (the ledger is also in `xrpl/recorded/`) |

Flag changes are rare: of the 1500 ledgers before the head (107871708 to 107873207), five Payments cleared PasswordSpent and one
account made the only four AccountSets that changed flags. The AccountSet case comes instead from the history of `rKqSPjN6okYt7iPk3xzWvuW9oN1Nk7vSUV`, an
issuer whose flags change in ledger 93663334 of `xrpl/amm/`, where its creation and its first AccountSet are a few ledgers apart.

Xahau's account flags are tested on `xahau/recorded/`: its account roots carry flags only Xahau has (URITokenIssuer 0x40000000 on
most of them, TshCollect on `rLqimfBcsc4x9Gy9jTfZUNktvJFLzTnv2n` in 26540711, DisallowIncomingRemit and DepositAuth on
`rD74dUPRFNfgnY2NzrxxYRXN4BrfGSN6Mv` in 26540188), so no Xahau ledger was recorded for them.

#### Trust line cases

Added 2026-10-24 from `wss://s2.ripple.com` (validated head 107873595) with `--txs` and `--delay-ms 500`: 8 more ledgers (454
KB gzipped, largest 142 KB). The trust line tests (`apps/api/test/account-trustlines.e2e-spec.ts`, same seed) read them, together
with the TUJ lines of `rKqSPjN6okYt7iPk3xzWvuW9oN1Nk7vSUV` that its holders and its AMM pool create in 93663330 and 93663334.
Freezes and authorizations were found with `account_lines` on issuers (`freeze`, `freeze_peer`, `authorized` set) and then
`account_tx` with `tx_type: TrustSet` on the holders; no recorded set had a quality, a freeze or an authorization before.

| Case | Ledger | Transaction | What the trust line does |
| --- | --- | --- | --- |
| `trustset_qualities` | 26922216 | `7AC4B79B90CDC9510BEC38B451ABAF877577731D55C0E0BFDA488BEAD42F2914` | `rKQxxMQxm6jHV82bq4BCwyfcxcGG9GPWiU` raises its LBR limit to 10000000; its side has QualityIn and QualityOut 1 |
| `trustset_freeze` | 26926380 | `40574C8990CD1EAD6D9831D6A32CBE16E3412CE0BDE48F5B86750A8BD8156CAD` | The same holder freezes the line (HighFreeze) and clears its qualities |
| `trustset_unfreeze` | 26926383 | `5F852D7E42E707A0F142EE525F4A427B3DDA8775BB724D6B9FA7E12A15CF25EC` | It clears the freeze again |
| `trustset_preauthorizes` | 104477592 | `7CD6BB1BEAFB159C576910B8A442FCD86FA92B2E8454CF8BE6190299AC9609EA` | The USDV issuer `rfffsukWALJB1PXYk7H8xkR6UJUDT8nMJE` creates a holder's line, authorized, at zero |
| `ammcreate_unauthorized_line` | 104478769 | `93605E3991FED4AED241A9A0274975394332E552BD38C15D7050F262F49DC9C9` | AMMCreate gives the pool `rPZZja3wKFEmAGGteziXYLT9Ne6SnT7H66` a USDV line of 700000, not authorized |
| `trustset_authorizes` | 104479125 | `C36AC10B9FA6AD15E2254477DFEF057D08589E39CA0102871D93622191D03D96` | The USDV issuer authorizes the pool's line |
| `trustline_created_at_zero` | 104566877 | `19B5C0FB6295872FCECCE7491806E3CE4A54067F4C43BC898BD1387EBC0D9DAB` | `rsMeJ5p6qzVARADTYhvZbHqwkfyN18U2XH` creates a USDV line with a zero balance |
| `trustline_deleted` | 104566926 | `49F56DB0FC454C5AEF99E8C538188523F7B3BBF932DC95B2981DBF1C0ED054C5` | It sets the limit back to 0: the line is a `DeletedNode` |

### Xahau (`xahau/recorded/`)

Recorded 2026-10-15 from `wss://xahau.network` (xahaud 2026.10.13-release+4119, network id 21337): validated head
26541064, 5000 ledgers scanned (26536065 to 26541064), 6 ledgers kept (477 KB gzipped, largest 238 KB).

`--want Import,ClaimReward,SetHook,Invoke,URITokenMint,URITokenBuy,Remit,GenesisMint --scan 5000`

| TransactionType | Ledger   | Transaction                                                        |
| --------------- | -------- | ------------------------------------------------------------------ |
| ClaimReward     | 26540187 | `3A1F25CDF0E2E4466AA0B019EA3039A6E5F87C01FBDD69CBDC474DAC32D8E64C` |
| GenesisMint     | 26540188 | `E8264F11B5CDD9844BFCF3C5CDFE99B5F7EBB91B3723C2CC8A1680FAD86EB22D` |
| Invoke          | 26540711 | `DE1FEAEA69ABF97EA8D95341A6C9B79094746CD8F35C0557583BB986867BB48D` |
| Remit           | 26540613 | `8C50C44787A12B785AA62377D0AFA6C4711E8E07EF68BA6E83DC286F7EE79AAF` |
| URITokenBuy     | 26541051 | `FDE327991B2702E7BF849A36487CEA0DE9BB307F5110F1621C9B8EEE6696AC5F` |
| URITokenMint    | 26541060 | `2EC9B35DA9FABDA4E375EBB158F7454E864FF24DDE4BD597F1EF6C04BC4EF4C3` |

**Not found** within the 5000-ledger window (no successful transaction of that type): `Import`, `SetHook`.

### UNL lists (`xrpl/unl/`, `xahau/unl/`)

Not ledgers: the validator lists the default publishers of each network profile serve (`defaultUnlPublishers`), saved
byte for byte as served, one file per publisher (`<publisher id>.json`). `FixtureLedgerSource` does not read these
directories. They are the real data behind `src/validators/manifest.spec.ts`, `unl-list.spec.ts` and `node-key.spec.ts`:
every list has to verify with the key of its profile, and every validator manifest in it has to decode and verify.

Recorded 2026-10-19 (06:42 UTC) with `record:fixtures -- --unl` (below). All three are version 1 lists with one blob, no
`effective` time and no `refresh_interval`.

| Publisher (file)              | Source URL              | Sequence   | Validators | Expires (blob)       | Bytes |
| ----------------------------- | ----------------------- | ---------- | ---------- | -------------------- | ----- |
| `xrpl/unl/vl.ripple.com.json` | `https://vl.ripple.com` | 85         | 35         | 2027-04-06T17:51:34Z | 20026 |
| `xrpl/unl/unl.xrplf.org.json` | `https://unl.xrplf.org` | 2026070302 | 35         | 2027-07-03T00:00:00Z | 20255 |
| `xahau/unl/vl.xahau.org.json` | `https://vl.xahau.org`  | 2026092401 | 19         | 2027-09-25T00:00:00Z | 11232 |

Every validator entry in the three lists carries its manifest (35 + 35 + 19 manifests); each decodes, re-encodes
identically and verifies. The specs assert these sequences and counts, so after re-recording they have to be updated to
what the new lists say. The specs take the time from the data (expiration minus one second, and so on), never from the
clock, so the lists expiring does not break them.

#### Re-recording

```bash
pnpm --filter @gatehub/data-api-shared record:fixtures -- --unl --network xrpl|xahau [--out <dir>]
```

`--unl` needs no `--endpoint` and takes none of the ledger options; `--out` defaults to `test/fixtures/<network>/unl`. It
GETs the URL of each default publisher of the network profile (Node `https`, at most 3 redirects, 20 s, 1 MiB) and
writes the body unchanged. Do not run a formatter over these files.

### Network state (`xrpl/network-state/`, `xahau/network-state/`)

Not ledgers either: what the validators worker asks the node for (`NetworkStatePoller`), saved as the node answered, one file per
request (the `result` of the answer; for an error, the error message the node served):

| File                | Request                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `amendments.json`   | `ledger_entry` of the Amendments object (`7DB0788C…`) at the validated ledger _L_                             |
| `negative_unl.json` | `ledger_entry` of the NegativeUNL object (`2E8A59AA…`) at _L_; `entryNotFound` while no validator is disabled |
| `fee_settings.json` | `ledger_entry` of the FeeSettings object (`4BC50C9B…`) at _L_                                                 |
| `server_info.json`  | `server_info` (the worker reads `validation_quorum`)                                                          |
| `feature.json`      | `feature` (a name and `supported` for every amendment the node knows)                                         |

They are the real data behind `apps/syncer/src/validators/network-state-poller.spec.ts` and the network state part of
`apps/syncer/test/validators.e2e-spec.ts` (the fake node of the e2e answers them back). The specs assert the values below, so after
re-recording they have to be updated to what the new answers say.

**XRPL**, recorded 2026-10-19 (11:22 UTC) from `wss://s2.ripple.com` (a Clio 2.8.0 server on rippled 3.4.1, which only serves validated
data) at validated ledger **107760758** (`75B3F5DE…EF19`):

- 97 enabled amendments and one majority: `98433DD0…CA76`, `CloseTime` 844853670 in Ripple time, which is 2026-10-09T09:34:30Z.
- **NegativeUNL: `entryNotFound`** (error code 98 from Clio), the object does not exist while no validator is disabled. The file holds
  the error message as served, with the request echoed back.
- FeeSettings in the drops form: `BaseFeeDrops` `"10"`, `ReserveBaseDrops` `"1000000"`, `ReserveIncrementDrops` `"200000"`.
- `server_info`: `validation_quorum` 28.
- `feature`: 115 amendments, all named, 104 supported and 11 not (the build does not know them).

**Xahau**, recorded 2026-10-19 (11:23 UTC) from `wss://xahau.network` (xahaud 2026.10.13-release+4119, network id 21337) with
`--ledger 26633715` (`D6C13393…2B80`), not the validated head: at the head of that minute (26638715) the NegativeUNL was `entryNotFound`
too, because the one validator that had been disabled was re-enabled between ledgers 26633715 and 26637715 (found by asking
`ledger_entry` at older ledgers), and the fixture is meant to hold a negative UNL that is not empty.

- 75 enabled amendments and two majorities: `2339E37C…F65F` (`CloseTime` 845332143, 2026-10-14T22:29:03Z) and `6902B1DE…9E1A`
  (845352140, 2026-10-15T04:02:20Z).
- **NegativeUNL with one disabled validator**: `PublicKey` `EDC38F0AC1B575A6AAC59C60D375ABE2E270BF5FAF8B9DA4A010F3C35B44A4464C`
  (`nHUqZcdCzkccxHQJp43M7nTTbHDbj2Yv9R1ty8zM1zFbtQFPnDu7`, a validator on the recorded Xahau list), `FirstLedgerSequence` 26615296; no
  `ValidatorToDisable` or `ValidatorToReEnable`.
- FeeSettings in the drops form, with the same three values as the XRPL (Xahau's object has more fields, such as `AccountCount`).
- `server_info` and `feature` are of the time of recording, not of ledger 26633715: `validation_quorum` is 0 (xahaud reports 0), and
  `feature` has 114 amendments, all named and supported, two of which carry a `majority`.

No recorded answer is in the legacy FeeSettings form (`BaseFee` in hex, `ReserveBase`, `ReserveIncrement`), none has a
`ValidatorToDisable` or `ValidatorToReEnable`, and no `feature` entry lacks a name: the specs that cover those say that their input is
hand-written.

#### Re-recording

```bash
pnpm --filter @gatehub/data-api-shared record:fixtures -- --network-state --network xrpl|xahau --endpoint <wss url> \
  [--out <dir>] [--ledger <n>]
```

`--out` defaults to `test/fixtures/<network>/network-state`. The script asks for the Amendments object at the validated ledger (or at
`--ledger`, which the node has to still hold), then for NegativeUNL and FeeSettings at that ledger, and for `server_info` and
`feature`, never more than 2 requests at a time. An `entryNotFound` for NegativeUNL is recorded as the answer it is; any other error, a
node of the other network (`network_id`), or a failed request ends the run with no file written. It takes none of the ledger options.
Do not run a formatter over these files.
