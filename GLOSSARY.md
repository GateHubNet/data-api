# GateHub Data API

Indexes XRP Ledger-protocol networks into ClickHouse (the syncer) and serves the indexed history over HTTP (the api).

## Language

**Network**:
A network the platform indexes: XRPL mainnet (`xrpl`), Xahau mainnet (`xahau`), or their testnets (`xrpl-testnet`, `xahau-testnet`). Each network has its own syncer, api and database, and never reads another network's nodes, lists or files.
_Avoid_: chain, environment

**Testnet**:
A test network of XRPL or Xahau, whose currency has no value and which can be reset: XRPL Testnet or Xahau Testnet. The sandbox indexes them.
_Avoid_: altnet, devnet (another network)

**Network family**:
The protocol a network runs, XRPL or Xahau. A testnet belongs to its mainnet's family and shares its amendment names and its toml file.
_Avoid_: chain, kind (that is mainnet or testnet)

**Network kind**:
Whether a network holds value (`mainnet`) or is for testing (`testnet`). A fact of the network's profile, never read from the environment; it decides the boot line (`kind=testnet`) and whether a head below the first indexed ledger halts the syncer.
_Avoid_: family (that is XRPL or Xahau), environment

**Network profile**:
Everything that differs between the networks, in one record per network: its name, family and kind, ids, native currency, default nodes and validator lists, files and database.
_Avoid_: network config, chain config

**Environment**:
A cluster the platform is deployed into: `production`, which indexes XRPL and Xahau mainnet, or the `sandbox`, which indexes XRPL Testnet and Xahau Testnet. Each has its own hosts and databases.
_Avoid_: network, stage, staging

**Coverage**:
Where an answer's history in the index starts, and whether the index holds all of it since the feature began on the network (its amendment's enable ledger, or the network's first ledger).
_Avoid_: completeness, backfill status

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

**Fee payer**:
The account that paid a transaction's fee: its sender, or the delegate when a delegate sent it.
_Avoid_: sender (when a delegate paid)

**Account flags**:
The settings the ledger keeps on an account, such as RequireAuth, DisallowXRP or DefaultRipple. Transactions set and clear them; the operator never does.
_Avoid_: labels, tags

**Display name**:
The name shown for an account instead of its address: its verified name, else its account name, else its unverified domain.
_Avoid_: label, alias, tag

**Verified name**:
A name both sides confirm: the account's domain lists the account in its toml, and the account names that domain. It is the toml entry's description, else the domain.
_Avoid_: verified label

**Account name**:
The name the operator gives an address, for example "GateHub" or "Bitstamp", shown as "Named by GateHub". It belongs to the address, so it is the same on every network.
_Avoid_: label, alias, tag

**Account network name**:
The name the operator gives an account on one network, which says what the address does there, for example "USD Issuer" for GateHub's issuing address on the XRP Ledger. It adds to the account name and does not replace it.
_Avoid_: account name (when one network is meant), alias

**Account domain**:
The domain an account's Domain field names, lower-cased, when it is a well-formed domain; a URL or an IPFS hash names none.
_Avoid_: domain field (for the domain itself), website

**Unverified domain**:
An account domain nothing vouches for: its toml does not list the account, could not be read, or has not been read yet.

**Label**:
A mark the operator puts on an address, such as `scam`, `spam` or `advisory`, from a fixed list. It carries a description, and optionally who says so and a link to where. A label belongs to the address, so it holds on every network.
_Avoid_: flag, tag, account flags

**Toml**:
The file a domain publishes about its validators, accounts, servers, currencies and principals: `xrp-ledger.toml` for XRPL, `xahau.toml` for Xahau.
_Avoid_: TOML file, well-known file

**Toml store**:
What each domain's toml said at its last read, one current row per domain and network, from which names, token listings and validator details are read. Only the checks fetch; a request never does.
_Avoid_: toml cache

**Principal**:
A person a toml names as responsible for the domain's validators or accounts. Only their names are kept.

**Token**:
Any asset other than the network's own: an issued token or an MPT.
_Avoid_: asset (for the native currency), coin

**Issued token**:
A token that lives on trust lines, named by its currency code and its issuer.
_Avoid_: IOU, issued currency, trust-line token

**Issuer**:
The account that issues a token.
_Avoid_: gateway

**Holder**:
An account that holds a positive balance of a token.
_Avoid_: owner (an NFT's word)

**Supply**:
Of an issued token: the sum of its holders' balances, which is what its issuer owes. The native currency has a total supply and a circulating supply instead, and an MPT an outstanding amount.
_Avoid_: circulating supply, outstanding amount (for an issued token)

**Listed in the issuer's toml**:
Said of an issued token whose issuer's account domain lists it, by code and issuer, under `[[CURRENCIES]]` in its toml. It says who publishes the token, not what it is worth.
_Avoid_: verified token

**Transfer**:
A move of a token or an NFT from one account to another: a payment that delivered a token (issuing and redeeming included), or an NFT changing owner without a price.
_Avoid_: trade (an exchange on the DEX)

**MPT**:
A multi-purpose token: a token that lives in its issuance and its holders' balances, named by its issuance ID.
_Avoid_: MPToken (in prose), multi-purpose token (after first use)

**Issuance ID**:
The 48 hex digits that name an MPT: the sequence of the transaction that created it and its issuer.
_Avoid_: MPT ID, currency (for an MPT)

**Asset scale**:
The power of ten an MPT's amounts are divided by to be read: at scale 2, 100 on the ledger is 1. Amounts are served unscaled.
_Avoid_: decimals, precision

**Outstanding amount**:
Of an MPT: how much of it its holders hold, escrowed amounts included.
_Avoid_: supply (an issued token's word), circulating

**Escrowed amount**:
Of an MPT: the part of its outstanding amount held in escrows (the ledger's `LockedAmount`).
_Avoid_: locked amount

**Locked balance**:
An MPT balance its issuer has locked, so that it cannot move until unlocked; an issuer can lock one holder's balance or every balance.
_Avoid_: frozen (a trust line's word), escrowed

**NFT**:
A non-fungible token: one token of its own, with an issuer and a URI. On XRPL an NFToken, on Xahau a URIToken.
_Avoid_: collectible

**NFToken**:
XRPL's kind of NFT, whose ID carries its flags, transfer fee, issuer, taxon and serial.

**URIToken**:
Xahau's kind of NFT: a ledger entry named by its issuer and its URI.
_Avoid_: URI token

**Collection**:
The NFTs of one issuer and one taxon on XRPL, or of one issuer on Xahau.
_Avoid_: series, set

**Taxon**:
The number an XRPL issuer gives a group of its NFTs; with the issuer it names a collection.

**Serial**:
The number an XRPL issuer's NFT gets when it is minted, one more for each of the issuer's NFTs.
_Avoid_: token number, edition

**NFT owner**:
The account that holds an NFT.
_Avoid_: holder (for one NFT)

**Collection holder**:
An account that owns at least one NFT of a collection.

**Sale**:
An NFT changing owner for a price through an accepted offer: direct, when the buyer or the seller accepts the other's offer, or brokered, when a third account matches a buy and a sell offer and keeps a fee.

**Royalty**:
The issuer's cut of an NFT's sale, set by the NFT's transfer fee. Served as an estimate; the issuer's balance change is the fact.
_Avoid_: creator fee

**Open offer**:
An offer to buy or sell an NFT that is still in the ledger: not accepted, cancelled or removed. An expired offer stays open until something removes it.

**Ledger object ID**:
The 64 hex digits that name an entry in the ledger, such as an escrow, a check or a payment channel. It stays the object's name after it is removed.
_Avoid_: index, hash

**Escrow**:
Native currency or a token an account sets aside for a destination until a time passes or a condition is met. It is pending, can be finished or can be cancelled, then is finished or cancelled.

**Check**:
A deferred payment its destination may cash, up to a limit, until it expires or is cancelled.

**Payment channel**:
Native currency or a token set aside for one destination, paid out in many off-ledger claims and settled on the ledger.
_Avoid_: paychan

**Removed**:
Said of a ledger object that is no longer in the ledger, however it went: finished, cancelled, cashed, closed, or deleted by another transaction. Its history is still served.
_Avoid_: deleted, closed (for every kind)

**Delegation**:
An account's grant to another account of permission to send some kinds of transaction on its behalf.

**Delegate**:
The account that receives a delegation and sends transactions on the other's behalf. It signs them and pays their fee.

**Permission**:
One kind of transaction, or one narrower right, that a delegation grants.

**Node**:
A `rippled` or `xahaud` server in a network's peer network.
_Avoid_: peer, server, rippled (for any node)

**Validator**:
A node whose validations count towards consensus, known by its master key.
_Avoid_: validating node

**Fixed list**:
Validators a network's nodes trust from their own configuration, with no publisher; stored as the list of the publisher `local`. Xahau Testnet's are the only ones.
_Avoid_: static UNL, local UNL

**Server country**:
The country a validator's verified toml says its server is in.
_Avoid_: location, geolocation

**Owner country**:
The country a validator's verified toml says its owner is in.
_Avoid_: nationality

**Unknown location**:
Said of a validator whose verified toml gives no valid server country, or that has no verified toml.
_Avoid_: unlocated

**Total supply**:
All of the native currency that exists: on XRPL, 100 billion XRP less what has been burned; on Xahau, what it started with and what has been minted, less what has been burned.

**Burned**:
Native currency destroyed as transaction fees.

**Minted**:
Native currency created on Xahau after its start: by rewards, by Import for XRP burned on XRPL, and by GenesisMint. (An NFT's mint creates an NFT, not native currency.)
_Avoid_: inflation, issuance

**Reward**:
XAH that Xahau mints for an account that claims it.
_Avoid_: staking reward, interest

**Escrowed**:
Native currency held in escrows.

**Circulating supply**:
The total supply less what is escrowed.
_Avoid_: free float, liquid supply

**Account reserves**:
The native currency accounts must keep and cannot send: a base reserve for each account and an owner reserve for each object it owns. Part of the circulating supply.
_Avoid_: locked, reserved balance

**Supply snapshot**:
The supply figures of one ledger, computed by the aggregator once an hour; only the newest is served.
_Avoid_: supply cache

**Token generation**:
One complete build of the issued-token aggregate, served whole and replaced whole by the next.
_Avoid_: snapshot, version (alone)

**State touch**:
A record, in ledger order, that a transaction changed a trust line or an issuer's settings, so that the token aggregate knows what to recompute.
_Avoid_: dirty mark

**Export**:
A file of a list of the indexed data, in CSV or PDF, that is made in the background and downloaded once it is ready.
_Avoid_: download, report, statement
