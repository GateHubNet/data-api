# ADR-0009: One deployment per network

**Status:** Accepted. Amended (2026-10-24): the testnets, in [the section at the end of this record](#amendment-2026-10-24-testnets). Where it differs from the
decisions below, the amendment holds: `GH_NETWORK` takes four names, not `xrpl|xahau`; a `xahau` process no longer accepts Xahau Testnet's node; the default
database is a fact of the profile. Design: [testnet profiles](../superpowers/specs/2026-10-24-testnet-profiles-design.md); the "plan rulings" below are those of
[its plan](../superpowers/plans/2026-10-24-testnet-profiles.md).

## Context
The Data API must serve the XRP Ledger and Xahau. The two networks share a data model and a wire contract, but differ in:

- the native currency (`XRP` / `XAH`; amounts of the native currency have no issuer),
- the CTID network id (0 / 21337) and the `network_id` a node reports,
- the node endpoints and the available history,
- the binary-codec definitions (Xahau has its own transaction types, hooks and `URIToken`s),
- the volume markets,
- fixes that only exist on one network (the partial-payment `delivered_amount` rule applies to XRPL ledgers up to 4,594,094 only).

Mixing both in one database or one process would put a network discriminator in every key, every query and every cache, and a node of the
wrong network would silently poison the data.

## Decision
- **One deployment per network** from the **same images**. `GH_NETWORK=xrpl|xahau` selects a *network profile*: node URLs, native currency, CTID
  network id, markets config, partial-payment cut-off, bundled definitions and the **default ClickHouse database** (`xrpl` / `xahau`).
- **One ClickHouse server, one database per network**, the same schema in both (created by a `migrate-<network>` job). The apis and syncers
  address their database through `GH_CLICKHOUSE_DATABASE` (defaulting to the network name).
- **One host per network**: `xrpl.data.<domain>` and `xahau.data.<domain>`, routed by nginx to `api-xrpl` / `api-xahau`. The URLs stay `/v2/...` on
  every host, so a client written for `data.ripple.com` only changes its host.
- **One syncer per network**, never scaled out: a fixed container name and a `syncer_lease` row in the network's database enforce a single writer.
- A process checks at boot that its node belongs to its network (`server_info.network_id`) and refuses otherwise; a default node endpoint comes
  from the profile, so a Xahau process never falls back to an XRPL node.

## Consequences
**Positive**
- No network discriminator anywhere: keys, queries and caches are per network by construction; a mistake affects one network.
- Networks scale, fail, upgrade and are backed up independently; Xahau can be absent or provisional (its markets list is provisional: derived from a short sample of history).
- The code paths are the same; the profile is the only switch, and every endpoint is tested with both networks.

**Negative / trade-offs**
- Two syncers and two api tiers to run; shared ClickHouse capacity must cover both.
- A client wanting both networks calls two hosts.
- Cross-network queries are impossible by design.

See [deployment](../deployment.md) and [configuration](../configuration.md).

## Amendment (2026-10-24): testnets

The explorer's sandbox shows XRPL Testnet and Xahau Testnet, with the same routes, the same answers' shapes and the same guarantees as production. The same
images now follow four networks, and everything above holds for each of them. Facts that decided it were read from the public nodes on 2026-10-24:
`s.altnet.rippletest.net` runs rippled 3.4.1, reports `network_id` 1 and holds ledgers 13073099 to 21795728; `testnet.xrpl-labs.com` reports 1 and holds about 2,000
ledgers; Ripple's testnet Clio (`clio.altnet.rippletest.net`, Clio 2.8.0) reports 1 and holds 209 to 21796150, the whole testnet, but drops connections after a few quick
requests; `xahau-test.net` runs xahaud `2026.10.16-tmp-dev`, reports 21338 and held 13293254 to 13463527 (about 5.7 days).

### Decision
- **A testnet is a network of its own.** `GH_NETWORK` takes `xrpl`, `xahau`, `xrpl-testnet` and `xahau-testnet` (`NETWORK_NAMES`, in this order wherever a
  list of them is printed), one complete profile each. "Testnet" is a fact of the profile (`kind`), never read from the environment: there is no second
  variable. A second variable (`GH_NETWORK=xrpl` with `GH_TESTNET=true`) was rejected, because forgetting it would run a testnet with mainnet's database, lists
  and files; with one record per network, every fact that differs is in one place. A network that is none of the four stays a code change: one profile
  and its files.
- **Name, family and kind.** A profile gains `family` (`xrpl` or `xahau`: the protocol and the node software), `kind` (`mainnet` or `testnet`),
  `displayName` (`XRP Ledger`, `Xahau`, `XRPL Testnet`, `Xahau Testnet`: the PDF export's header), `acceptedNodeNetworkIds` and `defaultUnlValidators`. Each place that
  branched on the network now keys on exactly one of the three:
  - the **name**: the files of markets and binary-codec definitions, the database, `syncer_lease.network`, the export object keys and the cache keys;
  - the **family**: the amendment metadata file (`config/amendments/<family>.json`) and the source of the account flags (Xahau's hand list, or the XRPL definitions
    file of the network);
  - the **kind**: the reset rule (below) and the boot line (`network=xrpl-testnet kind=testnet`; the lines of a mainnet are unchanged).

  The parsers still know no network (`parseContextFor` hands them the native currency, the CTID network id and the partial-payment cut-off). Every `networkId`
  is unique across the four, so the CTID of one network never names another, and a test pins it.

  | | `xrpl` | `xahau` | `xrpl-testnet` | `xahau-testnet` |
  | --- | --- | --- | --- | --- |
  | `family`, `kind` | `xrpl`, mainnet | `xahau`, mainnet | `xrpl`, testnet | `xahau`, testnet |
  | `networkId` (CTID) | 0 | 21337 | 1 | 21338 |
  | native currency | `XRP` | `XAH` | `XRP` | `XAH` |
  | node `network_id` accepted | none, or 0 | 21337 | 1 | 21338 |
  | database | `xrpl` | `xahau` | `xrpl_testnet` | `xahau_testnet` |
  | default node endpoints | `wss://s2.ripple.com`, `wss://xrplcluster.com` | `wss://xahau.network` | `wss://s.altnet.rippletest.net:51233`, `wss://testnet.xrpl-labs.com` | `wss://xahau-test.net` |
  | markets file | `xrpl.json` | `xahau.json` | `xrpl-testnet.json` (empty) | `xahau-testnet.json` (empty) |
  | definitions file | `xrpl.json` | `xahau.json` | `xrpl-testnet.json` | `xahau-testnet.json` |
  | host | `xrpl.data.gatehub.net` | `xahau.data.gatehub.net` | `xrpl.data.sandbox.gatehub.net` | `xahau.data.sandbox.gatehub.net` |

  The testnets' defaults are the public servers: the rippled servers for XRPL Testnet, the kind of node the syncer's streams (ledgers, validations, manifests) were
  verified against; the Clio throttles bursts and is a backfill source, not a live one. GateHub sets its own in `deploy/.env.sandbox`. The testnets ship empty markets
  files, because no testnet token is a market anyone relies on: the trade volume of a testnet has no market components, and its payment volume the native
  currency's alone.
- **Each process accepts exactly its own node.** `assertNetwork` reads `acceptedNodeNetworkIds` of the profile (the table above), with the message
  `Node network_id <id> does not match GH_NETWORK=<name>`. A sandbox started with mainnet endpoints, a mainnet rippled (which reports no `network_id`) under
  `xrpl-testnet`, and a Xahau Testnet node under `xahau` all fail at boot naming the variable. The last is a change for mainnet: until now `GH_NETWORK=xahau`
  accepted `network_id` 21338 and silently ingested Xahau Testnet. `record:fixtures` and `amendments:check` apply the same rule, so a mainnet node cannot be
  recorded under a testnet's name.
- **A database of its own.** `xrpl_testnet` and `xahau_testnet` by default, with the same schema and migrations as mainnet's, created by the migrate job of the slot.
  A testnet process pointed at a mainnet ClickHouse server by mistake therefore writes beside the mainnet data, never into it. The compose files no longer set
  `GH_CLICKHOUSE_DATABASE`: the database is the profile's (a process that sets the variable still overrides it).
- **The sandbox is a stack of its own.** The production compose file, on another host with a ClickHouse server of its own, with `deploy/.env.sandbox`
  (`cp deploy/.env.sandbox.example deploy/.env.sandbox`, then `docker compose -f docker-compose.prod.yaml --env-file deploy/.env.sandbox up -d --build`). The slots
  keep their names, `*-xrpl` and `*-xahau`, because nginx routes `xrpl.data.*` and `xahau.data.*` to them; `XRPL_NETWORK` and `XAHAU_NETWORK` (`xrpl` or
  `xrpl-testnet`; `xahau` or `xahau-testnet`) say which network a slot serves, and a name of the other family would serve the wrong protocol on the host. The hosts are
  `xrpl.data.<domain>` and `xahau.data.<domain>` as above, with the domains `gatehub.net` and `sandbox.gatehub.net`; the certificates must name all four hosts
  (`*.gatehub.net` covers none of them). Never a testnet api or syncer on the production server: the fixed container names already allow one stack to a Docker
  host, and the shared database ([ADR-0014](0014-address-names-and-labels-in-a-shared-database.md)) has the same name on every server, so a testnet on the
  production server would show its names and labels on mainnet. Production's env file sets neither variable and gets exactly what it got before. Exports are off in the
  sandbox unless it has a bucket of its own.
- **The sandbox indexes from the validated head of its first boot.** No backfill of testnet history: the rippled testnet servers hold under a year (XRPL Testnet) and a few
  days (Xahau Testnet), and the one full-history source, the Clio, throttles bursts, so a backfill through it would take months. The history before the first boot is
  not in the index, and nothing answers as if it were. A backfill can come later through `range-ingest` against that Clio or a node of GateHub's.
- **A testnet reset halts the syncer.** A testnet can be reset: its ledger indexes start again, under other hashes. The syncer used to wait for ever, healthy by every
  probe, because the node's validated head was below its checkpoint. The live runner now compares the node's ledger at a head below the checkpoint (once per distinct
  head, at most once a minute, and at boot before it fetches the checkpoint) with the stored hash: another hash is another chain and throws a `ChainBreakError`,
  `The node's validated ledger <head> has hash <h1>, but ledger <head> is stored with hash <h2>: the network was reset, or the node is of another chain`; the same
  hash means the node is only behind (a failover to a slower one), and the runner waits. When the head is below the first indexed ledger there is no stored hash to
  compare, and a **testnet** halts with `The node's validated head <head> is below the first indexed ledger <first>: the network was reset`; a mainnet waits, as
  before. The runbook ([operations](../operations.md#a-testnet-was-reset)) stops the network's services, drops its database (`xrpl_testnet` or `xahau_testnet`, never
  a mainnet name), runs the migrate job again and starts the syncer and the api; the shared database is kept, and the account network names go with the database.

### Decisions made while building it
- **The hash comparison halts every network.** Two hashes at one index can only mean another chain, so a mainnet syncer pointed at a node of another chain with a head
  below its checkpoint halts too, where it used to wait for ever. Only the "head below the first indexed ledger" halt is the testnets'. These two, the refusal of
  Xahau Testnet's node by `xahau` and the `retired` key that 15 rows of XRPL's amendments gain ([ADR-0012](0012-validators-and-amendments-data.md#amendment-2026-10-24-the-testnets))
  are the only changes of what a mainnet does or answers, besides the compose defaults written out differently with the same result. No migration, no parser version,
  no reprocess.
- **`record:fixtures` checks the node with the profile's accepted ids** (plan ruling 6): its own check let a mainnet rippled, which reports no `network_id`, record as
  `xrpl-testnet`.
- **`default` is a word of the two list variables only** (plan ruling 10): `GH_UNL_PUBLISHERS=default` and `GH_UNL_VALIDATORS=default` mean "the network's default", so compose
  passes `${XRPL_UNL_PUBLISHERS:-default}` instead of spelling mainnet's publishers out, which would have made an XRPL Testnet syncer trust mainnet's list.
  `GH_NODE_ENDPOINTS` keeps "blank is the default", which compose also uses.
- **The sandbox's validation endpoints are blank too.** Production's example sets mainnet servers for the validations collector, which the boot would refuse
  on a testnet.
- **Fields of later sub-projects** (plan ruling 1): `firstLedger`, `tomlNetworkNames`, `hasDelegation` and `hasMpt` are added to the four profiles by the sub-projects that need them.
- **The amendment metadata and the validator lists of the testnets** are in the [amendment of ADR-0012](0012-validators-and-amendments-data.md#amendment-2026-10-24-the-testnets);
  the hosts and what differs in the testnets' answers are in [api-reference](../api-reference.md#hosts-one-per-network). Each testnet ships the `server_definitions` of its
  own node, recorded with `record:fixtures`, as the codec's fallback.

### Consequences
**Positive**
- A testnet cannot be run with mainnet's database, lists or files by forgetting a variable: each fact that differs is in the profile, and a node of another network fails the boot.
- No network discriminator was added anywhere: the testnets are two more deployments of the same images, and every endpoint, config and test that takes a profile takes the four.
- A testnet reset is noticed and named instead of waited out.

**Negative / trade-offs**
- Four profiles, and the files of two testnets, to keep current; a testnet runs newer builds first, so its definitions file is the recording of its own node.
- The sandbox is a second stack (a host and a ClickHouse server) to run, with its own certificates, secrets and API keys.
- The testnets' defaults are public servers with short history; the sandbox shows only what it has indexed since its first boot, and a reset empties it.
- A `xahau` deployment that pointed at a Xahau Testnet node (which it accepted) now fails at boot.
