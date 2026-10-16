# ADR-0009: One deployment per network

**Status:** Accepted.

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
- Networks scale, fail, upgrade and are backed up independently; Xahau can be absent or provisional (its markets list ships empty).
- The code paths are the same; the profile is the only switch, and every endpoint is tested with both networks.

**Negative / trade-offs**
- Two syncers and two api tiers to run; shared ClickHouse capacity must cover both.
- A client wanting both networks calls two hosts.
- Cross-network queries are impossible by design.

See [deployment](../deployment.md) and [configuration](../configuration.md).
