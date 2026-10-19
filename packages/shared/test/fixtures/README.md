# Ledger fixtures

Raw ledgers used by parser, ledger-writer and API tests. Load a directory with `FixtureLedgerSource.fromDir(dir)`
(`src/ingest/fixture-ledger-source.ts`); it reads `<index>.json`, `<index>-<label>.json` and `<index>.json.gz` files and
ignores everything else in the directory (`manifest.json`, `server_info.json`, `README.md`, ...).

| Directory              | Contents                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `xrpl/ripple-mock/`    | The 54 mock ledgers of the original Ripple Data API (ISC); see its own `README.md`.     |
| `xrpl/recorded/`       | Mainnet ledgers recorded from a public node (see below).                                |
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
  transaction hash) and which were not.

### Re-recording

```bash
pnpm --filter @gatehub/data-api-shared exec ts-node scripts/record-fixtures.ts \
  --network xrpl|xahau --endpoint <wss url> --out test/fixtures/<network>/recorded \
  [--ledgers 1,2,3] [--want TypeA,TypeB --scan N] [--delay-ms 75] [--any-result]
```

(`pnpm --filter @gatehub/data-api-shared record:fixtures -- <same args>` is the same command.)

`--want` walks back one ledger at a time from the validated head and keeps a ledger only if it holds a wanted
`TransactionType` that has not been found yet. A type counts as found on its first `tesSUCCESS` transaction (pass
`--any-result` to accept any result code). The scan stops when every wanted type is found or `--scan` ledgers have been
checked. Requests are sequential, with a pause between ledgers, and throttling by the server is waited out.

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
