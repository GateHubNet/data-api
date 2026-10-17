# Ledger fixtures

Raw ledgers used by parser, ledger-writer and API tests. Load a directory with `FixtureLedgerSource.fromDir(dir)`
(`src/ingest/fixture-ledger-source.ts`); it reads `<index>.json`, `<index>-<label>.json` and `<index>.json.gz` files and
ignores everything else in the directory (`manifest.json`, `server_info.json`, `README.md`, ...).

| Directory           | Contents                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- |
| `xrpl/ripple-mock/` | The 54 mock ledgers of the original Ripple Data API (ISC); see its own `README.md`. |
| `xrpl/recorded/`    | Mainnet ledgers recorded from a public node (see below).                            |
| `xrpl/amm/`         | Mainnet AMM transactions, one ledger per named case (see below).                    |
| `xahau/recorded/`   | Xahau mainnet ledgers recorded from a public node (see below).                      |

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
