# Testnet profiles: design (D-env)

Status: proposed (2026-10-24), program 2, sub-project D-env. Repository `data-api`, branch `feat/explorer-data-2` (stacked on PR #20).

- The explorer's side: x-explorer `docs/superpowers/specs/2026-10-24-sandbox-environment-design.md` (E7), built after this one.
- The program: x-explorer `docs/superpowers/specs/2026-10-24-explorer-program-2-overview.md`.
- Mock: x-explorer `docs/superpowers/specs/2026-10-24-explorer-mock/TokensMpt.dc.html` (the Tokens board with `environment="sandbox"`:
  "XRPL Testnet" / "Xahau Testnet" in the switch, the breadcrumbs and the sentences, and a "Testnet" badge). Nothing on any board needs
  a new data API field.
- What this extends: [ADR-0009](../../adr/0009-one-deployment-per-network.md) (one deployment per network, the network profile),
  [ADR-0012](../../adr/0012-validators-and-amendments-data.md) and its spec `2026-10-19-validators-amendments-design.md` (D1: validator
  lists, amendment metadata), [ADR-0014](../../adr/0014-address-names-and-labels-in-a-shared-database.md) (the shared database).

## Owner decisions to confirm

| # | Choice | Recommendation and why |
|---|---|---|
| 1 | A testnet is a network of its own: `GH_NETWORK` takes `xrpl-testnet` and `xahau-testnet`, one complete profile each (section 2). | Recommended over a second variable (`GH_NETWORK=xrpl` + `GH_TESTNET=true`): every fact that differs (node ids, endpoints, lists, files, database) is then in one record, and forgetting a variable cannot run a testnet with mainnet's database and lists. |
| 2 | Testnet databases are `xrpl_testnet` and `xahau_testnet` by default (section 9). | A testnet process pointed at a mainnet ClickHouse by mistake writes beside the mainnet data, never into it. |
| 3 | The sandbox is its own stack on its own host and ClickHouse server, from the same compose file with `deploy/.env.sandbox` (section 10). Never a testnet api or syncer on the production ClickHouse. | The fixed container names already allow one stack per host; and the shared database (names, labels) has one name on every server, so a shared server would show a testnet's names on mainnet. |
| 4 | The sandbox indexes from its first boot (the validated head); no backfill of testnet history (section 12). | The rippled testnet nodes hold under a year (XRPL Testnet) and a few days (Xahau Testnet); the one full-history source, Ripple's testnet Clio (from ledger 209), throttles bursts, so a backfill through it would take months. Every list there shows its coverage notice, which is the truth. A backfill can come later through `range-ingest` against it or a GateHub node. |
| 5 | XRPL Testnet's list publisher is `https://vl.altnet.rippletest.net`. Xahau Testnet has **no publisher**: its nodes trust a fixed `[validators]` list of four keys. A new syncer setting `GH_UNL_VALIDATORS` holds such a list, stored as the list of the publisher `local` (section 5). | Without it no Xahau Testnet validator is trusted, and the amendment tallies and the validators pages of the sandbox say nothing. Alternative: no trusted set on Xahau Testnet (no new setting). |
| 6 | Testnets read their family's amendment metadata file (`config/amendments/xrpl.json`, `xahau.json`) and ignore its `enabled` entries, which are mainnet's ledgers and dates (section 6). | One file of names and descriptions per protocol; enablement on a testnet comes from its own ledger. |
| 7 | `retired` becomes valid on XRPL entries, and the 15 amendments rippled lists with `XRPL_RETIRE` are marked (section 6). | XRPL Testnet's ledger does not list them (they were retired before its genesis), so without the mark they would read "voting" there. On mainnet nothing changes: they are in the ledger. |
| 8 | Testnets ship an empty markets config (section 8). | No testnet token is a market anyone relies on; the volume series of the sandbox are empty, not wrong. |
| 9 | The default node endpoints of the testnets are the public servers (`wss://s.altnet.rippletest.net:51233`, `wss://testnet.xrpl-labs.com`; `wss://xahau-test.net`); GateHub sets its own in `deploy/.env.sandbox`. | As for mainnet: a working default, overridden per deployment. |
| 10 | The `xahau` profile stops accepting a node that reports `network_id` 21338 (section 4). | Today `GH_NETWORK=xahau` silently ingests Xahau Testnet; each network now accepts exactly its own id. |
| 11 | A testnet reset halts the syncer (`ChainBreakError`), and the runbook drops and recreates that network's database (section 11). | Ledger indexes repeat with other hashes after a reset; nothing can be kept. |
| 12 | `GH_UNL_PUBLISHERS=default` (and `GH_UNL_VALIDATORS=default`) means "the network's default", so compose no longer spells out mainnet's publishers (section 10). | The compose default text is XRPL mainnet's, which would make an XRPL Testnet syncer trust mainnet's list. |
| 13 | Amendment majority hold on the testnets: 14 days (XRPL Testnet) and 5 days (Xahau Testnet), as on mainnet, **to verify** before the profiles ship (section 1). | Neither network publishes the value; the plan records how it was checked. |
| 14 | Exports are off in the sandbox unless it is given a bucket of its own. | A testnet export is for testing the feature only. |

## Goal

Run the same images on XRPL Testnet and Xahau Testnet, as the data APIs of the **sandbox** (`xrpl.data.sandbox.gatehub.net`,
`xahau.data.sandbox.gatehub.net`), with the same routes, the same answers' shapes and the same guarantees as production
(`xrpl.data.gatehub.net`, `xahau.data.gatehub.net`): a process refuses a node of another network, never falls back to another network's
nodes, lists or files, and keeps its data in a database of its own.

## Scope

- Two network profiles, `xrpl-testnet` and `xahau-testnet`, and the shape that makes a profile a complete record (family, kind, name).
- Everything that today branches on the network name, sorted into what follows the network, the family (XRPL or Xahau protocol) or
  the kind (mainnet or testnet).
- The validator lists of both testnets, including the fixed list of Xahau Testnet.
- The amendment metadata, binary-codec definitions and markets config of the testnets.
- Deploying the sandbox: compose variables, an env file, hosts and certificates.
- Detecting a testnet reset, and its runbook.
- The rule other program-2 specs follow for `coverage` on a testnet.

## Non-goals

- Devnet, sidechains, or any network but the four. A new network stays a code change (one profile and its files), not configuration.
- A backfill of testnet history, and full-history testnet nodes.
- A route that names the network. A client knows the network by the host it calls (ADR-0009).
- Any new endpoint, table or parser. No migration, no parser version.
- The explorer's side (E7).

## 1. The four profiles

`packages/shared/src/network/network-profile.ts`. Facts marked † were read from the public nodes on 2026-10-24 (`server_info`,
`ledger_entry` of the `Amendments` object, `server_definitions`) and from the publishers' own files.

| Field | `xrpl` | `xahau` | `xrpl-testnet` | `xahau-testnet` |
|---|---|---|---|---|
| `family` (new) | `xrpl` | `xahau` | `xrpl` | `xahau` |
| `kind` (new) | `mainnet` | `mainnet` | `testnet` | `testnet` |
| `displayName` (new) | `XRP Ledger` | `Xahau` | `XRPL Testnet` | `Xahau Testnet` |
| `networkId` (CTID) | 0 | 21337 | 1 † | 21338 † |
| `acceptedNodeNetworkIds` (new) | none, 0 | 21337 | 1 † | 21338 † |
| `nativeCurrency` | `XRP` | `XAH` | `XRP` | `XAH` |
| `defaultDatabase` | `xrpl` | `xahau` | `xrpl_testnet` | `xahau_testnet` |
| `defaultNodeEndpoints` | `wss://s2.ripple.com`, `wss://xrplcluster.com` | `wss://xahau.network` | `wss://s.altnet.rippletest.net:51233`, `wss://testnet.xrpl-labs.com` | `wss://xahau-test.net` |
| `partialPaymentFixLedger` | 4594094 | 0 | 0 | 0 |
| `software` | `rippled` | `xahaud` | `rippled` | `xahaud` |
| `tomlPath` | `/.well-known/xrp-ledger.toml` | `/.well-known/xahau.toml` | `/.well-known/xrp-ledger.toml` | `/.well-known/xahau.toml` |
| `defaultUnlPublishers` | `vl.ripple.com`, `unl.xrplf.org` (as today) | `vl.xahau.org` (as today) | `https://vl.altnet.rippletest.net=ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860` † | `''` (none) † |
| `defaultUnlValidators` (new) | `''` | `''` | `''` | the four keys of section 5 † |
| `majorityHoldSeconds` | 1209600 | 432000 | 1209600 (verify) | 432000 (verify) |
| `amendmentThresholdPercent`, `flagInterval` | 80, 256 | 80, 256 | 80, 256 | 80, 256 |
| definitions file | `config/definitions/xrpl.json` | `xahau.json` | `xrpl-testnet.json` (new) | `xahau-testnet.json` (new) |
| markets file | `config/markets/xrpl.json` | `xahau.json` | `xrpl-testnet.json` (new, empty) | `xahau-testnet.json` (new, empty) |
| amendment metadata | `config/amendments/xrpl.json` | `xahau.json` | `xrpl.json` (`enabled` ignored) | `xahau.json` (`enabled` ignored) |

What the nodes said on 2026-10-24 †: `s.altnet.rippletest.net` runs rippled 3.4.1, reports `network_id` 1, holds ledgers
13073099–21795728; `testnet.xrpl-labs.com` reports 1 and holds about 2,000 ledgers; `clio.altnet.rippletest.net` (ports 51233 / 51234)
is Clio 2.8.0, reports 1 and holds 209–21796150, the whole testnet, but drops connections after a few quick requests; `xahau-test.net`
runs xahaud `2026.10.16-tmp-dev`, reports 21338 and holds 13293254–13461222. The defaults are the rippled servers, the kind of
node the syncer's streams (ledgers, validations, manifests) and its rate-limit handling were verified against on mainnet; the throttling
Clio is a backfill source, not a live one. `https://vl.altnet.rippletest.net` serves a version-1 list signed by `ED2648…5860`. Xahau
Testnet's configuration (`Xahau/Xahau-Testnet-Docker`, `store/etc/validators-xahau.txt`, and the commented testnet block of
`xahaud/cfg/validators-example.txt`) has a `[validators]` list and no `[validator_list_sites]`.

The majority hold of the testnets is not published. The plan checks it before the profiles ship, from a pair of `EnableAmendment`
pseudo-transactions of the testnet (`tfGotMajority`, then the enabling one with flags 0) or from the testnet operators, and writes
in the profile's comment where the value came from. `network-profile.spec.ts` pins it.

Types:

```ts
export type NetworkName = 'xrpl' | 'xahau' | 'xrpl-testnet' | 'xahau-testnet';
export type NetworkFamily = 'xrpl' | 'xahau';
export type NetworkKind = 'mainnet' | 'testnet';
/** In this order: the order of every message and test that lists them. */
export const NETWORK_NAMES: readonly NetworkName[] = ['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet'];
```

`NetworkProfile` gains `family`, `kind`, `displayName`, `acceptedNodeNetworkIds: ReadonlyArray<number | undefined>` and
`defaultUnlValidators: string`; `nativeCurrency` stays `'XRP' | 'XAH'`. Every `networkId` is unique across the four (the CTID of one
network never names another); a test pins it. Later program-2 specs add fields of their own to all four profiles, each with its four
values: D3 `firstLedger`, D4 `tomlNetworkNames`, D5 `hasDelegation`, D9 `hasMpt`.

## 2. The configuration shape

- **`GH_NETWORK`** takes the four names. The apps' `@IsIn(['xrpl', 'xahau'])` (`api.config.ts`, `syncer.config.ts`, `exporter.config.ts`)
  becomes `@IsIn(NETWORK_NAMES)` with the message `GH_NETWORK must be one of xrpl, xahau, xrpl-testnet, xahau-testnet`. `getNetworkProfile`
  throws `Unknown GH_NETWORK "<name>"` as today. The scripts (`record-fixtures.ts`, `amendments-check.ts`) take `--network` from the same
  list (`--network must be one of …`).
- **No second variable.** "Testnet" is a fact of the profile (`kind`), never read from the environment.
- **`GH_UNL_VALIDATORS`** (syncer, new): section 5.
- **`GH_UNL_PUBLISHERS`** gains one spelling: `default` (trimmed, any case) is the same as unset, the network's default publishers. Empty
  still means no lists. So compose can pass `${XRPL_UNL_PUBLISHERS:-default}`.
- **`GH_CLICKHOUSE_DATABASE`** defaults to the profile's `defaultDatabase`, as today; the compose files stop setting it (section 10).

## 3. What depends on what

Every place that names a network today, and what it keys on after this change. "Name" is the network (`xrpl-testnet`), "family" the
protocol (`xrpl`), "kind" mainnet or testnet.

| Place | Today | After |
|---|---|---|
| `network-profile.ts` `PROFILES` | 2 entries | 4 entries, keyed by name |
| `account-flags.ts` `accountFlagsOf` | `profile.name === 'xahau'` | `profile.family === 'xahau'` (the hand list); XRPL reads `LEDGER_ENTRY_FLAGS.AccountRoot` from the network's own definitions file. The cache stays keyed by name |
| `node-client.ts` `ACCEPTED_NETWORK_IDS` | a table by name, `xahau: [21337, 21338]` | `profile.acceptedNodeNetworkIds` (section 4); the table goes |
| `assertNetwork` message | `does not match GH_NETWORK=xahau` | unchanged wording, with the name |
| `clickhouse.config.ts` default database | `profile.defaultDatabase` | unchanged (new values) |
| `loadMarketsConfig` | `config/markets/<name>.json` | unchanged, by name (new files) |
| `definitionsFallback` | `config/definitions/<name>.json` | unchanged, by name (new files) |
| `amendments-config.ts` `loadAmendmentsConfig` | `config/amendments/<name>.json`, `network` must equal the name | `config/amendments/<family>.json`; section 6 |
| `amendments-config.ts` version pattern, `retired` | by `software` | version pattern by `software` as today; `retired` valid on both families (section 6) |
| `server-version.ts` | by `software` | unchanged |
| `domain-checker.ts` toml URL | `profile.tomlPath` | unchanged |
| `parser.interface.ts` `parseContextFor` | native, network id, partial-payment ledger | unchanged: the parsers know no network |
| `range-ingest.ts` `networkOf(ctx)` | loops over `['xrpl', 'xahau']` | loops over `NETWORK_NAMES` (the ids are unique) |
| `syncer_lease.network`, export object keys `<network>/…`, the amendments and validator-directory cache keys | the name | unchanged: `xrpl-testnet/…` |
| `apps/exporter/src/pdf-file.ts` `NETWORK_NAMES` (`{ xrpl: 'XRP Ledger', xahau: 'Xahau' }`) | a table by name | the PDF header reads `profile.displayName`; the table goes |
| `syncer.config.ts` `defaultUnlPublishersOf`, `defaultNodeEndpoints` | the profile's | unchanged; plus `defaultUnlValidatorsOf` |
| `app.module.ts` boot lines (api, syncer, exporter) | `network=xrpl` | add `kind=testnet` on a testnet |

Nothing else in `apps/*/src` or `packages/shared/src` reads the network name (checked with the searches of the inventory:
`=== 'xahau'`, `=== 'xrpl'`, `'XAH'`, `21337`, `21338`, `NetworkName`).

## 4. The node's network

`assertNetwork(info, profile)` (`packages/shared/src/xrpl/node-client.ts`) accepts a node whose `server_info.network_id` (or its absence)
is in `profile.acceptedNodeNetworkIds`:

| Profile | Accepts | Refuses, for example |
|---|---|---|
| `xrpl` | no `network_id`, 0 | 1 (XRPL Testnet), 21337 |
| `xahau` | 21337 | 21338 (Xahau Testnet), 0 |
| `xrpl-testnet` | 1 | none (a mainnet rippled), 0, 2 (Devnet) |
| `xahau-testnet` | 21338 | 21337 |

The message stays `Node network_id <id> does not match GH_NETWORK=<name>`. It runs where it runs today (the syncer's and the api's node
clients at boot, `record-fixtures`, `amendments-check`), so a sandbox started with mainnet endpoints fails at boot, naming the variable's
network. The `xahau` change (no longer 21338) is decision 10.

## 5. Validator lists on the testnets

**XRPL Testnet** has one publisher, `https://vl.altnet.rippletest.net` with the key
`ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860`; it is the profile's `defaultUnlPublishers`. Nothing else changes for
it: the `validators` worker fetches, verifies and stores its list as it does Ripple's.

**Xahau Testnet** has no publisher. Its nodes trust the four master keys of their `[validators]` section:

```
nHBoJCE3wPgkTcrNPMHyTJFQ2t77EyCAqcBRspFCpL6JhwCm94VZ
nHUVv4g47bFMySAZFUKVaXUYEmfiUExSoY4FzwXULNwJRzju4XnQ
nHBvr8avSFTz4TFxZvvi4rEJZZtyqE3J6KAAcVWVtifsE7edPM7q
nHUH3Z8TRU57zetHbEPr1ynyrJhxQCwrJvNjr4j1SMjYADyW1WWe
```

They are the profile's `defaultUnlValidators` (comma separated). The plan compares them with `validators-xahau.txt` of
`Xahau/Xahau-Testnet-Docker` on the day it builds, and the profile's comment names that file and its commit.

**`GH_UNL_VALIDATORS`** (syncer, `SyncerConfig.unlValidators`): comma separated validator master public keys in base58 (`n…`), trusted
without a publisher, as rippled's `[validators]` are. Unset or `default`: the network's `defaultUnlValidators`. Empty: none. Each entry is
trimmed, must decode as a node public key (`decodeNodePublic` of `ripple-address-codec`) and may not repeat; a bad entry fails the boot
with `GH_UNL_VALIDATORS entry <n>: <why>` (`must be a validator public key (n…)`, `repeats a key`), like `GH_UNL_PUBLISHERS`. New
`parseUnlValidators(text): string[]` in `unl-publishers.ts`, beside `parseUnlPublishers`.

**How the fixed list is stored.** As the list of a publisher with the reserved id **`local`** (`LOCAL_PUBLISHER_ID` in
`unl-publishers.ts`), so that the tally, the agreement, the directory and the API read it with no branch of their own:

- `UnlFetcher.registerPublishers()` writes, besides the configured publishers, a `unl_publishers` row `{ publisher: 'local', url: '',
  publisher_key: '', configured: 1, threshold, status: 'ok', error: '', last_ok_at: <now> }` when the fixed list is not empty, and the
  `configured: 0` row when it is empty and a `local` row is stored (as for a publisher taken out of the configuration).
- It writes a `unl_lists` row when the newest stored `local` list differs from the configured keys (or none is stored):
  `{ publisher: 'local', publisher_key: '', sequence: <newest stored + 1, else 1>, version: 1, effective: <now>, expiration: 4294967295
  (the DateTime maximum, 2106-02-07T06:28:15Z), validators: <the keys, sorted>, blob_sha256: <SHA-256 of the sorted keys joined by "\n">,
  fetched_at: <now>, response: '{"validators":[…]}' }`. A restart with the same keys writes nothing: the history of the list stays
  what it was, and past rounds read the list that was in force.
- `local` is never fetched (no timer, no metric of a fetch).
- `unlPublishersOf(cfg)` is unchanged; a new `unlListCount(cfg)` is the number of publishers plus one when the fixed list is not empty.
  `unlThresholdOf(cfg)` uses it: `defaultUnlThreshold(unlListCount(cfg))` when `GH_UNL_THRESHOLD` is 0, and the boot bound of
  `GH_UNL_THRESHOLD` is `unlListCount(cfg)`. rippled counts its local list the same way.
- `ListContext.publishers` (`stored-lists.ts`) includes `local` when it is configured.
- `parseUnlPublishers` refuses a URL whose id is `local` (`GH_UNL_PUBLISHERS entry <n>: the id "local" is reserved`).

**What the API shows.** `/v2/network/validators/summary` lists `local` among `unl.publishers`, in the directory's order (by id,
`ORDER BY publisher` of `readPublishers`). It omits `expiration` for `local` (a fixed list does not expire); `url`
and `public_key` are empty strings, the type's own values. Example, Xahau Testnet:

```json
"unl": {
  "trusted": 4,
  "threshold": 1,
  "publishers": [
    { "id": "local", "url": "", "public_key": "", "status": "ok", "sequence": 1, "version": 1,
      "fetched": "2026-11-02T10:00:00.000Z", "validators": 4, "seen_24h": 4 }
  ]
}
```

A validator on the fixed list has `"unl": true` and `"unl_lists": ["local"]` in `/v2/network/validators` and
`/v2/network/validators/{key}`. The explorer labels `local` (E7 section 7.6). ADR-0010 item 44 gains one sentence: `unl_lists` may name
`local`, the fixed list of `GH_UNL_VALIDATORS`.

## 6. Amendments on the testnets

**The metadata file.** `loadAmendmentsConfig(profile, path?)` reads `config/amendments/<family>.json` when `path` is empty, so a testnet
reads its mainnet's file. `parseAmendmentsConfig(raw, profile)` then:

- accepts `network` equal to the profile's name or its family (`"xrpl"` for `xrpl-testnet`); anything else is refused as today
  (`"xahau" is not the network of this deployment, "xrpl-testnet"`);
- keeps the `enabled` entries only when `network` is the profile's own name. A family file read by a testnet keeps names,
  versions, XLS links, descriptions, `obsolete` and `retired`, and drops `enabled`, which records mainnet's ledgers and dates. An operator
  can give a testnet a file of its own (`GH_AMENDMENTS_CONFIG`, `"network": "xrpl-testnet"`) whose `enabled` entries hold;
- `AmendmentsConfig.network` is the profile's name.

On a testnet an amendment's `enabled` therefore comes from the indexed `EnableAmendment` (`source: "ledger"`), or is absent: the status
is still `enabled` (it is in the ledger's `Amendments`), with no ledger or date. That is what the sandbox can know.

**`retired` on XRPL.** rippled's `features.macro` lists 15 amendments with `XRPL_RETIRE`: `MultiSign`, `TrustSetAuth`, `FeeEscalation`,
`PayChan`, `CryptoConditions`, `TickSize`, `fix1368`, `Escrow`, `fix1373`, `EnforceInvariants`, `SortedDirectories`, `fix1201`, `fix1512`,
`fix1523`, `fix1528`. Their code is unconditional, and a ledger begun after their retirement never lists them: XRPL Testnet's
`Amendments` lacks exactly these 15 of mainnet's 97 (checked 2026-10-24). The loader's rule `retired: is for Xahau only` goes; the
`introduced` patterns stay by `software`. `config/amendments/xrpl.json` marks the 15 `"retired": true` (keeping their `enabled`).
`amendmentStatus` already reads `inLedger || retired` as enabled, and shows a retired amendment's `enabled` only when the ledger has
it, so mainnet's answers do not change; XRPL Testnet's show the 15 as enabled without a date.

**What the testnets have that mainnet lacks** (2026-10-24, `Amendments` object of each validated ledger): XRPL Testnet, nothing (82
enabled, all on mainnet). Xahau Testnet has 14 that Xahau mainnet does not: `AMMClawback`, `EscrowDestinationCancel`,
`HookAPISerializedType240`, `HookOnV2`, `HookOnV2_1`, `HooksUpdate2`, `NamedHooks`, `OnChainManifests`, `PWALoader`, `RNG`,
`fixEnforceNFTokenTrustline`, `fixNFTokenPageLinks`, `fixNFTokenReserve`, and one ID that `config/amendments/xahau.json` does not
name, `AB6612F1B9C2EAB6F687512297D9960B13B869EFF97E77D85A0574DFF97FD1EE`. Before the profiles ship, `amendments:check --network
xahau-testnet` (section 16) lists the names to add to `xahau.json`; the unknown ID is named from xahaud's `features.macro` (D1's F10). The
API shows an unnamed one as `unknown` until then, as it does on mainnet.

**`amendments:check`** takes `--network xrpl-testnet|xahau-testnet` with the testnet's default endpoint, and checks the family file
against the testnet's node (names it knows that the file lacks, IDs nobody names). With the `enabled` entries dropped, the third list
(enabled ledgers that differ from the indexed `EnableAmendment`) is empty on a testnet.

## 7. Binary-codec definitions

The api asks its node for `server_definitions` at boot and every 30 s while it has a fallback; the bundled file is only the fallback
(`binary-codec.service.ts`, unchanged). The testnets get files of their own, recorded with `record:fixtures --network <testnet>` from the
public node and copied to `config/definitions/xrpl-testnet.json` and `xahau-testnet.json` (the `server_definitions.json` it writes).
On 2026-10-24 the testnets' definitions had the same transaction types, ledger entry types and fields as the bundled mainnet files;
they are separate files because a testnet runs newer builds first (`xahau-test.net` runs a dev build), and a testnet node's definitions
are what that network's transactions need. `network-profile.spec.ts` checks that each bundled file is its network's (XRPL Testnet's has
no `ClaimReward`; Xahau Testnet's has `Import` and `ClaimReward`). `account-flags.ts` reads XRPL Testnet's `LEDGER_ENTRY_FLAGS` from
its own file. The Docker build's check of `config/definitions/*.json` covers the new files.

## 8. Markets

`config/markets/xrpl-testnet.json` and `xahau-testnet.json`: `{ "version": 1, "tradeMarkets": [], "paymentCurrencies": [] }`.
`assertValidMarketsConfig` accepts empty lists today. The volume jobs read no market (`tradeLegs` returns nothing for none), so
`/v2/network/exchange_volume` and `/v2/network/payment_volume` answer rows with no components and a total of 0 on the testnets, and the
rates of non-native assets are missing. `/v2/network/markets` (D2) lists every traded pair whatever the config, and works as on mainnet.

## 9. Databases, hosts and the edge

- **Databases.** `xrpl_testnet` and `xahau_testnet`, created by the migrate job of the network's slot (`migrate-xrpl` running with
  `GH_NETWORK=xrpl-testnet`), with the same schema, migrations and shared database migrations as mainnet. `assertValidDatabaseName`
  accepts them (`^[a-z_][a-z0-9_]*$`). The shared database keeps its name, `shared`, on the sandbox's own server (decision 3).
- **Hosts.** Production: `xrpl.data.gatehub.net`, `xahau.data.gatehub.net`. Sandbox: `xrpl.data.sandbox.gatehub.net`,
  `xahau.data.sandbox.gatehub.net`. Both are `xrpl.data.<domain>` and `xahau.data.<domain>` of ADR-0009, with the domain `gatehub.net`
  and `sandbox.gatehub.net`.
- **nginx** (`deploy/nginx/nginx.conf.template`): no change. Its map `~^xrpl\.data\.` and `~^xahau\.data\.` and its `server_name
  xrpl.data.* xahau.data.*` match the sandbox hosts, and route them to `api-xrpl` and `api-xahau`, the slots, which in the sandbox run the
  testnets. The comment above the map gains the sandbox hosts.
- **TLS** ends at the front proxy (ADR-0006). The certificates must name the four hosts: a single-label wildcard does not cover them
  (`*.gatehub.net` covers neither `xrpl.data.gatehub.net` nor the sandbox hosts); `*.data.gatehub.net` and `*.data.sandbox.gatehub.net`,
  or the four names, do. `docs/deployment.md` says so.

## 10. Deploying the sandbox

The sandbox is the production compose file on another host, with another env file:

```bash
cp deploy/.env.sandbox.example deploy/.env.sandbox      # then fill in the secrets
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.sandbox up -d --build
```

**Changes to `docker-compose.prod.yaml`** (and the same to `docker-compose.yaml`, so a developer can run a testnet locally):

| Service | Today | After |
|---|---|---|
| `migrate-xrpl`, `syncer-xrpl`, `api-xrpl`, `exporter-xrpl` | `GH_NETWORK: xrpl` | `GH_NETWORK: ${XRPL_NETWORK:-xrpl}` |
| `migrate-xahau`, `syncer-xahau`, `api-xahau`, `exporter-xahau` | `GH_NETWORK: xahau` | `GH_NETWORK: ${XAHAU_NETWORK:-xahau}` |
| the same services | `GH_CLICKHOUSE_DATABASE: xrpl` / `xahau` | removed: the profile's `defaultDatabase` |
| `syncer-*`, `api-*` | `GH_NODE_ENDPOINTS: ${XRPL_NODE_ENDPOINTS:-wss://s2.ripple.com,wss://xrplcluster.com}` | `${XRPL_NODE_ENDPOINTS:-}`: blank is the profile's default (both config classes treat it so) |
| `syncer-*` | `GH_UNL_PUBLISHERS: ${XRPL_UNL_PUBLISHERS:-https://vl.ripple.com=…}` | `${XRPL_UNL_PUBLISHERS:-default}` |
| `syncer-*` | — | `GH_UNL_VALIDATORS: ${XRPL_UNL_VALIDATORS:-default}`, `${XAHAU_UNL_VALIDATORS:-default}` |

`XRPL_NETWORK` is `xrpl` or `xrpl-testnet`, `XAHAU_NETWORK` `xahau` or `xahau-testnet`; the slot's name says which family it serves
(nginx routes `xrpl.data.*` to it). A value of the other family would serve Xahau on the XRPL host; the compose file's comment says so,
and every app logs `network=… kind=…` at boot. Production's env file sets neither, and gets exactly what it gets today.

**`deploy/.env.sandbox.example`** (new): the production example's variables, with

```bash
XRPL_NETWORK=xrpl-testnet
XAHAU_NETWORK=xahau-testnet
XRPL_NODE_ENDPOINTS=          # empty = wss://s.altnet.rippletest.net:51233,wss://testnet.xrpl-labs.com; GateHub's own nodes here
XAHAU_NODE_ENDPOINTS=         # empty = wss://xahau-test.net
XRPL_UNL_PUBLISHERS=          # empty = default: https://vl.altnet.rippletest.net=ED2648…5860
XAHAU_UNL_PUBLISHERS=         # empty = default: none
XAHAU_UNL_VALIDATORS=         # empty = default: the four Xahau Testnet validators
XRPL_SYNC_START_LEDGER=       # empty = the validated head (decision 4)
XAHAU_SYNC_START_LEDGER=
GH_EXPORT_BUCKET=             # empty = exports off (decision 14)
GH_API_KEYS=<the sandbox explorer's key>,…
GH_RATE_LIMIT_KEYS=<the sandbox explorer's key>=<budget>
```

The sandbox's explorer has its own key, in the sandbox's `GH_API_KEYS` and `GH_RATE_LIMIT_KEYS` (E7 sets it as the Worker secret
`DATA_API_KEY --env sandbox`). The start order is production's. Sizing: the testnets carry a few transactions a ledger; the
production ClickHouse limits are far more than enough.

## 11. Testnet resets

A testnet can be reset: its ledger indexes start again, under other hashes. Today a reset leaves the syncer waiting forever (the node's
validated head is below the committed checkpoint, so there is nothing to fetch), healthy by every probe; and a restart retries the fetch
of a checkpoint the node does not have.

**Detection** (`apps/syncer/src/ingest/live-runner.ts`):

- When the validated head the source reports is below the committed checkpoint, the runner fetches the node's ledger at that head
  (at most once a minute, `HEAD_BELOW_CHECK_MS` = 60000, and once per distinct head) and compares its hash with the stored one
  (`storedLedgerHash(ch, head)`). Another hash throws `ChainBreakError("The node's validated ledger <head> has hash <h1>, but ledger
  <head> is stored with hash <h2>: the network was reset, or the node is of another chain", head)`. The same hash means the node is
  behind (a failover to a slower node); the runner waits, as today. This holds for every network: two hashes at one index can only mean
  another chain.
- When the head is below the first stored ledger (no stored hash to compare), a testnet profile (`kind === 'testnet'`) throws
  `ChainBreakError("The node's validated head <head> is below the first indexed ledger <first>: the network was reset", head)`; a
  mainnet profile waits, as today.
- `prepare()` (boot) asks for the validated head before it fetches the checkpoint, and runs the same check when the head is below it.

`ChainBreakError` already halts the runner (status `halted`, `/liveliness/healthz` 503, `syncer_ingest_status`), with the message in
the log.

**Runbook** (`docs/operations.md`, "A testnet was reset"): stop `syncer-<slot>`, `api-<slot>` and `exporter-<slot>`; drop the network's
database (`DROP DATABASE xrpl_testnet`, never a mainnet name); `run --rm migrate-<slot>`; start the syncer and the api. The account
network names of that database go with it: insert them again ([operations](../../operations.md#name-an-address)). The shared database
(account names, labels) is kept. The explorer's side: E7 section 11 (a sandbox deploy with a new build id).

## 12. Coverage on the testnets

The program's `coverage: { from_ledger_index, complete }` (overview, decision 5) needs no testnet branch, if each spec follows one rule:

- `from_ledger_index` is the first ledger the index holds for the feature, as on mainnet (in the sandbox, the first ledger it ingested).
- A feature's amendment ledger is read from the amendments assembly (`AmendmentView.enabled.ledgerIndex`, the indexed `EnableAmendment`
  or, on mainnet, the metadata), never from a constant. On a testnet that is the indexed `EnableAmendment` alone (section 6); when it is
  absent, `complete` is `false`.

So every coverage notice shows in the sandbox. D3 builds this rule into the program's one coverage service (D3 §4, with the case of a
feature that has no amendment: the testnets have no `firstLedger`, so it is `false` too); D5–D9 register their features with it, and a
test of each runs once on a testnet profile (`complete: false` with no indexed `EnableAmendment`).

D8 (validator toml details) serves a toml's `[[VALIDATORS]] network` as the file's claim, unchecked (D8 decision 8); the explorer
compares it with the network's kind to say "not this network" (E13 §5.2).

## 13. What the explorer relies on

- The hosts of section 9, the same `/v2` routes and answers on all four.
- CTIDs carry the profile's `networkId`: `…0000` XRPL, `…5359` Xahau, `…0001` XRPL Testnet, `…535A` Xahau Testnet.
- The native currency is `XRP` / `XAH` on the testnets too.
- XRPL Testnet has AMM (the `AMM` amendment is enabled there, 2026-10-24); Xahau Testnet does not.
- No USD market: the volume answers have no components on the testnets (section 8).
- Xahau Testnet's validators are listed by `local` (section 5).
- The explorer's own node calls do not go through the data API. E7 points the sandbox's XRPL node at Ripple's testnet Clio
  (`https://clio.altnet.rippletest.net:51234/`), so that Clio-only methods (`nft_info`, the NFT pages' fallback of E8) answer there as
  they do on mainnet's `s1.ripple.com` (Clio 2.8.0). The data API's own node endpoints are unaffected.

## 14. XRPL and Xahau

| | XRPL Testnet | Xahau Testnet |
|---|---|---|
| Trust | one publisher | a fixed list of four (`local`) |
| Amendments ahead of mainnet | none today | 14 (section 6), one unnamed |
| AMM | yes | no |
| Public history (2026-10-24) | ~8.7 M ledgers on `s.altnet` | ~170 k ledgers on `xahau-test.net` |
| Account flags | from its definitions file | the hand list of `account-flags.ts` |
| Hooks, URIToken, Import | — | as on Xahau mainnet (`Import` burns come from XRPL Testnet; nothing to configure) |

## 15. Backfill and reprocess

None for production: no migration, no parser version, no change to stored rows. `config/amendments/xrpl.json` gains `retired` marks, which
change no mainnet answer (section 6). The sandbox starts empty at its first boot.

## 16. Docs to update

- `docs/adr/0009-one-deployment-per-network.md`: an "Amendment (2026-10-24): testnets" section: four profiles, `family` and `kind`,
  `acceptedNodeNetworkIds`, the testnet databases, the sandbox as its own stack, the reset rule.
- `docs/adr/0012-validators-and-amendments-data.md`: the fixed list (`GH_UNL_VALIDATORS`, publisher `local`); `retired` on XRPL; the
  family file on testnets.
- `docs/adr/0010-ripple-v2-wire-compatibility.md`: item 44, one sentence (section 5).
- `docs/configuration.md`: `GH_NETWORK` values and the boot message (sections 1 and 2); `GH_UNL_PUBLISHERS` `default`; a row for
  `GH_UNL_VALIDATORS`; the testnet defaults in the `GH_NODE_ENDPOINTS` and `GH_UNL_PUBLISHERS` rows; section 7's compose variables
  (`XRPL_NETWORK`, `XAHAU_NETWORK`, `*_UNL_VALIDATORS`, the new defaults) and "Which service gets which variables" (no
  `GH_CLICKHOUSE_DATABASE` from compose); the check at the end (the new property).
- `docs/deployment.md`: "Environments" (production and sandbox, their hosts, one host each); the sandbox commands; the certificates;
  the topology diagram's note.
- `docs/api-reference.md`, "Hosts: one per network": rows for XRPL Testnet (`XRP`, CTID 1) and Xahau Testnet (`XAH`, CTID 21338), and
  the production and sandbox hosts; the validators summary's `local` publisher.
- `docs/architecture.md` and `docs/development.md`: the four profiles, the files per network and per family.
- `docs/syncer.md`: the accepted `network_id`s (line 44 says "Xahau 21337/21338"); the head-below-checkpoint check.
- `docs/operations.md`: "A testnet was reset"; the sandbox's `amendments:check`.
- `docs/troubleshooting.md`: the two new `ChainBreakError` messages.
- `docs/data-model.md`, `docs/clickhouse.md`: the database names.
- `README.md`: the hosts; `apps/*/.env.example`: the `GH_NETWORK` values and `GH_UNL_VALIDATORS`; `deploy/.env.prod.example`: the
  `XRPL_NETWORK` / `XAHAU_NETWORK` lines (commented, mainnet) and the new defaults; `deploy/.env.sandbox.example` (new).
- `packages/shared/test/fixtures/README.md`: the testnet fixtures.

## 17. Testing

**Unit** (`*.spec.ts`, Jest):

- `network-profile.spec.ts`: the table of section 1 for all four profiles; `NETWORK_NAMES`; unique `networkId`s; valid database names;
  each bundled definitions file is its network's; the testnet markets files load with empty lists; `Unknown GH_NETWORK "xrpl-devnet"`.
- `node-client.spec.ts` (`assertNetwork`): the table of section 4, each cell.
- `account-flags.spec.ts`: `xrpl-testnet` reads its definitions; `xahau-testnet` the hand list.
- `unl-publishers.spec.ts`: XRPL Testnet's default publisher parses; `parseUnlValidators` (the four keys; empty; a bad key; a repeat; a
  key in the `ED…` hex form, refused); a publisher URL whose id is `local` is refused.
- `amendments-config.spec.ts`: a testnet loads its family file and drops `enabled`; a file whose `network` is the testnet's name keeps
  `enabled`; `"network": "xahau"` for `xrpl-testnet` is refused; `retired` on an XRPL entry is accepted; the shipped `xrpl.json` marks the
  15 retired.
- `amendment-status.spec.ts`: a retired XRPL amendment not in the ledger is `enabled` with no `enabled` object.
- `syncer.config.spec.ts`, `api.config` and `exporter.config` tests: the four `GH_NETWORK` values; the new message; `GH_UNL_PUBLISHERS=default`
  (any case) is the default; `GH_UNL_VALIDATORS` unset, `default`, empty and a list; `GH_UNL_THRESHOLD` bound with `local`.
- `unl-fetcher.spec.ts`: `registerPublishers` writes the `local` publisher and list; the same keys again write no list; changed keys
  write sequence + 1; an empty list with a stored `local` writes `configured: 0`; `local` gets no timer.
- `tally.spec.ts`, `agreement.spec.ts`: a validator on the `local` list alone is trusted at threshold 1.
- `summary-object.spec.ts`: the `local` publisher has no `expiration`.
- `live-runner.spec.ts`: head below the checkpoint with another hash halts with the message; with the same hash it waits; on a testnet
  profile a head below the first stored ledger halts, on a mainnet profile it waits; `prepare()` runs the check at boot.
- `range-ingest.spec.ts`: `networkOf` for CTID ids 1 and 21338.
- `pdf-file.spec.ts`: the header says `Network: XRPL Testnet`.
- `record-fixtures` and `amendments-check` argument tests: the four names.

**End to end** (testcontainers ClickHouse, recorded fixtures):

- `packages/shared/test/migrate.e2e-spec.ts`: `GH_NETWORK=xrpl-testnet` creates and migrates `xrpl_testnet`.
- `apps/api/test/tx-object.e2e-spec.ts`: two new seeds, `xrpl-testnet-recorded` and `xahau-testnet-recorded` (`SEED_NETWORK`), in its
  `describe.each`: the `ctid` ends `0001` / `535A`, amounts of the native currency say `XRP` / `XAH`, the binary form round-trips with
  the testnet's bundled definitions.
- `apps/api/test/validators.e2e-spec.ts`: a Xahau Testnet seed with the fixed list: `unl.trusted` 4, the `local` publisher as in section 5,
  `unl_lists: ["local"]` on a listed validator.
- `apps/api/test/main.e2e-spec.ts`: `GH_NETWORK=bitcoin` fails with the new message.
- `apps/syncer/test`: a boot against a fake node reporting `network_id` 21338 under `GH_NETWORK=xahau` is refused.

**Fixtures to record** (`pnpm --filter @gatehub/data-api-shared record:fixtures -- --network <testnet> --endpoint <node> --out …`),
each with its provenance in `packages/shared/test/fixtures/README.md`:

- `packages/shared/test/fixtures/xrpl-testnet/recorded/`: three consecutive validated ledgers of XRPL Testnet from
  `wss://s.altnet.rippletest.net:51233`, chosen to hold a `Payment` and an `OfferCreate` (an AMM transaction if one is near), and the
  node's `server_definitions` (copied to `config/definitions/xrpl-testnet.json`).
- `packages/shared/test/fixtures/xahau-testnet/recorded/`: three consecutive ledgers of Xahau Testnet from `wss://xahau-test.net` with a
  `Payment` (a `SetHook` or `URITokenMint` if one is near), and its `server_definitions` (to `xahau-testnet.json`).
- `packages/shared/test/fixtures/xrpl-testnet/unl/`: `--unl --network xrpl-testnet`, the list of `vl.altnet.rippletest.net`.
- `packages/shared/test/fixtures/xahau-testnet/network-state/`: `--network-state --network xahau-testnet` (the `Amendments` object),
  for the validators e2e seed.

## 18. Build order

1. Profiles: types, `NETWORK_NAMES`, the four records, the definitions and markets files; `network-profile.spec.ts`.
2. The config classes and scripts take the four names; `range-ingest`'s `networkOf`; the PDF's `displayName`.
3. `acceptedNodeNetworkIds` and `assertNetwork`.
4. Amendment metadata: family file, `enabled` rule, `retired` on XRPL and the 15 marks; `amendments:check --network <testnet>` run and
   the Xahau names added.
5. Validator lists: `GH_UNL_PUBLISHERS=default`, `GH_UNL_VALIDATORS`, the `local` publisher in the fetcher, threshold, summary.
6. Reset detection in the live runner.
7. Compose files, `deploy/.env.sandbox.example`, `.env.example` files.
8. Testnet fixtures and the e2e tests.
9. Docs and ADRs; the majority hold verified and written down.
