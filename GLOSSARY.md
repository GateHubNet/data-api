# GateHub Data API

Indexes XRP Ledger-protocol networks into ClickHouse (the syncer) and serves the indexed history over HTTP (the api).

## Language

**Network**:
A mainnet the platform indexes: `xrpl` (XRP Ledger) or `xahau` (Xahau). Each network has its own syncer, api and database, and never reads another network's nodes.
_Avoid_: chain, testnet, environment

**Environment**:
A cluster the platform is deployed into: `sandbox` or `production`. Every environment indexes mainnet networks; sandbox is a smaller deployment, not a testnet.
_Avoid_: network, stage, testnet

**Address**:
The `r…` identifier of a key pair. One key pair has the same address on every network, so whoever holds it controls it everywhere.
_Avoid_: wallet

**Account**:
An address as it exists on one network: activated there, with its own balances, trust lines and flags. An address can be an account on one network and not on another.
_Avoid_: wallet, address (when the per-network state is meant)

**Activation**:
The payment that first funded an account on a network, which brought it into existence. An activation has a time, an amount and a transaction. An account that was deleted and funded again has more than one activation.
_Avoid_: creation, funding, inception

**Parent**:
The account that sent an account's activation.
_Avoid_: activator, creator, funder

**Trust line**:
The relationship between two accounts that lets one hold the other's issued currency, with its balance, each side's limit, its no-ripple, freeze and authorization settings, and its quality in and out.
_Avoid_: trust set (that is the transaction that changes one), token, IOU balance

**Path payment**:
A successful payment whose delivery used someone else's liquidity: an offer, an AMM pool, or an account other than the delivered currency's issuer rippling between its trust lines. Rippling only through that issuer does not make a path payment, and neither does a `Paths` field that went unused. A payment to oneself through other liquidity, such as an arbitrage loop, is a path payment.
_Avoid_: pathfinding transaction, cross-currency payment, rippling payment

**Account flags**:
The settings the ledger keeps on an account, such as RequireAuth, DisallowXRP or DefaultRipple. Transactions set and clear them; the operator never does.
_Avoid_: labels, tags

**Account name**:
The display name the operator gives an address, for example "GateHub" or "Bitstamp". It belongs to the address, so it is the same on every network.
_Avoid_: label, alias, tag

**Account network name**:
The display name the operator gives an account on one network, which says what the address does there, for example "USD Issuer" for GateHub's issuing address on the XRP Ledger. It adds to the account name and does not replace it.
_Avoid_: account name (when one network is meant), alias

**Label**:
A mark the operator puts on an address, such as `scam`, `spam` or `advisory`, from a fixed list. It carries a description, and optionally who says so and a link to where. A label belongs to the address, so it holds on every network.
_Avoid_: flag, tag, account flags

**Export**:
A file of a list of the indexed data, in CSV or PDF, that is made in the background and downloaded once it is ready.
_Avoid_: download, report, statement
