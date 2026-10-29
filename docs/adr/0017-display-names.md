# ADR-0017: Display names: the account domain from the ledger, the toml store, and a batch of names

**Status:** Accepted. Amends [ADR-0010](0010-ripple-v2-wire-compatibility.md#amendment-6-2026-10-24-display-names) (Amendment 6, items 79 to 83) and
[ADR-0014](0014-address-names-and-labels-in-a-shared-database.md) (a batch lookup of names after all). An exception to
[ADR-0007](0007-ledger-index-axis-and-secondary-tables.md)'s unique-key rule for one table, and the second user of the safe fetcher of
[ADR-0012](0012-validators-and-amendments-data.md). Builds on [ADR-0015](0015-historical-account-state-from-clickhouse.md) (the state history the
seed and the coverage come from). The design is in [the display names spec](../superpowers/specs/2026-10-24-display-names-design.md), program 2
sub-project D4.

## Context
The explorer shows an address by name wherever it shows one: in every table of every page. That is one batch of names per page render, not one
lookup per address, and the names it wants are, in order of trust, a **verified name** (the account names a domain, and that domain's toml lists the
account), the name the operator gave the address (ADR-0014), and a domain nothing vouches for. Three things were missing:

- The **domain of an account** is a field of its `AccountRoot`; the index kept no current copy of it (`account_states` has it in every row, over billions of
  rows, with no key by account that a page can read).
- The **toml** of a domain is a file on somebody's website. Nothing read it for accounts: the `validators` worker reads the tomls of ~150 validator
  domains to verify a manifest.
- ADR-0014 serves names inline on `GET /v2/accounts/{address}` and **rejected lookup endpoints of their own**, "because the readers want them on the
  account". A page of 100 addresses is not one account.

## Decision
1. **The display name rule** (pure, `displayNameOf`): `verified`, else `account` (the account name, else the account network name), else `domain`, else
   none. `verified`: the address has an account domain and that domain's toml, in effect, lists it under `[[ACCOUNTS]]` in an entry that counts on this
   network; its text is the entry's `desc` when it is 1 to 64 characters, else the domain (nothing is cut). A `desc` can claim any name, so the answer
   always pairs a name with `domain`. Until the api has loaded the toml directory once, a domain gives no name: unknown is not "not verified".
2. **An account's domain is a Domain that is one.** The bytes are printable ASCII (0x21 to 0x7E) and, lower-cased, pass rippled's
   `isProperlyFormedTomlDomain`; `https://x.com`, a path, an IP address or an IPFS hash name no domain (`accountDomainOf`, one rule for the worker and
   the api).
3. **`account_domains`, ordered by account** (migration 012, parser version 6): a row for every change of an `AccountRoot` that has or had a Domain,
   `version` = `ledger_index * 2^32 + tx_index * 2^16 + node_index` (written as text: it passes 2^53), so that the current domain of an account is its row
   with the largest `version` (`argMax`, never `FINAL`). It is a ledger-derived table in `CHILD_TABLES` and `LEDGER_KEYED_TABLES` that is **not**
   ordered by its unique key: the exception to ADR-0007 below.
4. **The `tomls` worker and the toml store.** A sixth syncer worker reads, every five minutes, which domains accounts name, and fetches the toml of
   every one that is due (300 a pass, 16 at a time) through the safe fetcher with the toml limits (10 s, 256 KiB, three checked redirects, https on 443).
   It writes one row per check to `domain_tomls` (`ReplacingMergeTree(checked_at)`, `ORDER BY domain`): `ok` after 24 hours; a transient failure after an hour
   with the last good content carried for 24 hours; a definite failure after 1, 2, 4, then 7 days with none; a domain more accounts name than at the last
   discovery is checked at once (at most hourly). The store keeps `[[ACCOUNTS]]`, `[[CURRENCIES]]`, `[[VALIDATORS]]`, the **names** of `[[PRINCIPALS]]` and
   `modified` and `expires`; never a principal's email or social handle, `[[SERVERS]]` or `[ORGANIZATION]`; a toml's text is parsed, never evaluated, never
   stored, and nothing it holds is fetched. `expires` is kept, not acted on. The store is the one the program's later readers (the token listings, the
   validator details) read: `recordToml`, `readStoredTomls`, `countsOn` and `cleanTomlText` are in `packages/shared`.
5. **`GET /v2/account_names`**: 1 to 100 classic addresses, one entry each in the order asked (a repeated address is answered at each place and counts towards
   the 100; an X-address is a 400), with the display name, the domain, the account name, the account network name and the labels. The labels are
   ADR-0014's, under the key `labels` where the account says `account_labels`. Any address is answered, an account or not. A failed read of the account
   domains fails the batch (500) instead of answering without them.
6. **`GET /v2/toml/{domain}`** serves what the store holds for one domain, only the entries that count on the network and only the keys the reference
   lists (404 `toml not found`, 400 `invalid domain`). The api never fetches on request.
7. **Which entries count on a network**: those with no `network` or one of the network's names (`tomlNetworkNames` of the profile: XRPL `main`, `mainnet`;
   Xahau `main`, `mainnet`, `xahau`, `21337`; XRPL Testnet `testnet`; Xahau Testnet `testnet`, `21338`). The writer keeps every network's entries and
   the readers filter.

## Consequences
- **Egress to tens of thousands of hosts.** The worker makes a `GET` of one URL of a fixed shape to the host of any domain an account names, once a day: the
  same exposure as the validators' manifests at a larger scale, and anyone can make it fetch one by setting a Domain. It goes through the safe fetcher only
  (public addresses, pinned DNS, https and 443, bounded time and size, its own `User-Agent`, `gatehub-data-api/<version> (tomls)`), a hostname allowlist is
  impossible, and `GH_DOMAIN_VERIFICATION=false` switches the worker off for a host without outbound HTTPS: every domain then shows as kind `domain`
  ([security](../security.md#outbound-https-to-arbitrary-public-hosts-syncer), [deployment](../deployment.md#outbound-network-access)). A host that is
  down or slow costs a lane of the 16 for up to ten seconds, once an hour.
- **Coverage comes from the state history** (ADR-0015). The seed copies the current domain of every account from `account_states`, once per network, and no
  reprocess is needed ([backfill](../backfill.md#account-domains-seed)). An account whose Domain was set before that history starts and whose root has not
  changed since has no domain, so no verified name, until it changes or the history is complete. The names answer carries no `coverage` key.
- **The exception to ADR-0007.** `account_domains` keeps a row for each change of an account that has a domain, and the worker reads the current domain of
  every account; ordered by its unique key it would be a sizeable share of `account_states`, ordered by `account` the merges keep about one row per account
  and partition. It is safe because recovery and `--reprocess` delete by `ledger_index` and always write the deleted ledgers again with a deterministic
  parser: a row merged away under a deleted one comes back with it. The cost is that its row counts after a merge are not counts of what the parser wrote
  (tests compare accounts, not rows), and readers must take the newest `version` themselves.
- **ADR-0014's rejected lookup is accepted for batches.** The names, the network names and the labels are still ADR-0014's in-memory sets, reloaded every
  60 seconds, and the inline fields of `/v2/accounts/{address}` are unchanged; the batch adds the one read that is not in memory, the account domains of
  the page, by key from `account_domains`. A toml directory (the entries of every stored toml, as address to `desc`) is loaded with the names.
- **The safe fetcher has a second user** (ADR-0012): a worker of its own, so a stall of its fetches never delays the validators' checks, with the same
  address policy. The two share the lane runner and the log rules. A log line names a domain (quoted and cut), a reason and a status code, never a body, an
  error object or a principal; an error is logged by its name.
- **A verified name is whatever the domain's owner wrote.** `verified` says that the account names the domain and the domain lists the account; the
  explorer shows the domain beside the name. A `desc` over 64 characters is not a name. Text is cleaned (Unicode normal form C, no controls or
  bidirectional overrides, one space between words), so a name cannot render as another's.
- **One custom key can fail a whole file.** The parser (`smol-toml` 1.3.1) refuses an integer it cannot hold exactly (above 2^53 - 1), so a currency entry
  with `max_supply = 100000000000000000` makes the file `toml_invalid` and the domain shows no content, however the rest reads. The same holds for the
  validators' check. `modified` and `expires` are kept for every date a `DateTime` column holds (1970 to 2106), whatever their value against now.
- **Bounds.** The batch reads `account_domains` by key, at most one granule (`index_granularity` 1,024) of rows per address per part, and a read can reach
  about one and a half granules per part, because ClickHouse folds a tail shorter than half a granule into the previous one; `/v2/toml/{domain}` reads one
  row of a domain by key. Both are pinned by `read_rows` tests on a bulk of parts (800,000 rows of `account_domains`: 226,560 read, bound 409,600; parts of
  exactly 3 granules of `domain_tomls` for the exact bound). The worker's discovery and its schedule read each their whole table, once in five minutes and
  once a minute.
- **A first sweep is the backlog**: about 300 domains a minute, slower when many hosts time out (16 lanes of up to 10 s: 96 a minute). Until a domain is
  checked it shows as kind `domain`. The stop budget of the worker (2 s) is shorter than a fetch (10 s): a SIGTERM during slow fetches loses the finished
  rows of the pass that has not been written, and those domains are checked again, which costs a fetch and no data.
- **A dead website is asked once an hour for ever** when its failure is transient (a name that does not resolve, a host that times out): the backoff of 1, 2,
  4 and 7 days is for definite failures only.
- **Deploy order:** migration 012 first (the ingest writes `account_domains` with every ledger, and a write to a missing table fails the batch; the tomls
  worker refuses to boot without it), then the syncer and the api, then the seed ([operations](../operations.md#the-display-names)).
- Rejected: fetching a toml on request (the api never fetches, and one slow host would hold a page); a name index and search by name (it needs an index of
  its own); following the URLs of a toml (icons, attestations, `unl` lists); a domain per row of `account_states` read at request time (a key by account over
  billions of rows).
