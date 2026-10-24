# Issued tokens: design (D6)

Status: proposed (2026-10-24), program 2, sub-project D6. Repository `GateHubNet/data-api`, branch `feat/explorer-data-2` (stacked on
PR #20, `feat/account-investigation-data`).

- Boards: x-explorer `docs/superpowers/specs/2026-10-24-explorer-mock/Tokens.dc.html` (the list), `TokensMpt.dc.html` (the MPT tab, D9 and
  E14), `Token.dc.html` (one token), `Account.dc.html` (the Tokens card). Their data is made up.
- Program: x-explorer `docs/superpowers/specs/2026-10-24-explorer-program-2-overview.md`. The explorer side is E11,
  x-explorer `docs/superpowers/specs/2026-10-24-token-pages-design.md`.
- Builds on: ADR-0015 and PR #20's `account_states` (migration 005) and `trust_line_states` (006, `GET /v2/accounts/{a}/trustlines`); D2 and
  D2b's markets aggregates (`markets_live`, ADR-0013); D3's shared `FeatureCoverageService` (with its no-amendment case and
  `NetworkProfile.firstLedger`) and parser-gate pattern (`2026-10-17-nft-data-design.md`, revised, §2 and §4); D4's per-domain toml
  store and its readers (`2026-10-24-display-names-design.md` §8). D9
  (`2026-10-17-mpt-data-design.md`, revised) adds `kind=mpt` to the list designed here.

## Owner decisions to confirm

| # | Choice | Recommendation |
|---|---|---|
| 1 | **A token** is a (currency, issuer) with at least one trust line on which the other account holds it or trusts the issuer (§1). A line on which the "holder" owes counts for the other side's token. | As written: it is how `gateway_balances` sees an issuer. |
| 2 | **Holders** are lines with a positive balance; **trust lines** add those with a zero balance and a limit above 0; **supply** is the sum of the holders' balances (the issuer's obligations). | As written. "Supply", not "circulating": that word is the native currency's (glossary). |
| 3 | **LP tokens are not tokens here** (currency `03…`): they are left out of the aggregate; their page is the pool's. | As written. |
| 4 | **A new ledger table, `state_touches`, and a new parser version**, to find what changed since the job's cursor without scanning the state tables (§2.1). Reading `transactions.meta_json` in the job instead was weighed (§2.1). | The touch table: the `amm_pool_touches` precedent (Ruling R-A14). |
| 5 | **The aggregate is built in generations**: a full build from `trust_line_states`, then kept current from the touches; a config change or a change of the state coverage builds a new generation beside the live one and swaps it in whole (§3). | As written. |
| 6 | **Price and 24 h volume are read at request time** from the `markets_live` sets, not stored in the token rows. Price: the last trade against the native currency in the `day` set, else in the `30day` set; the 24 h change only from the `day` set (§5.5). | As written. A token that has not traded against the native currency in 30 days has no price. |
| 7 | **The list is ranked by holders**, then issuer and currency, with a `rank` per row; the marker is a cursor into a ranking that moves each minute (as `/v2/amm/pools`). | As written. |
| 8 | **`totals` use a fixed floor of 10 holders** (`tokens_with_10_holders`), whatever the request's `min_holders`; `totals.holders` counts accounts holding any issued token; `totals.native_volume` is the whole `day` markets set. | As written: the boards' tiles do not change with "Show all" or a search. |
| 9 | **Search (`q`)** matches the display code, the toml name, the issuer's domain, the 40-hex currency and the issuer address; not the issuer's display name (that is the explorer's names call). | As written. |
| 10 | **"Listed in the issuer's toml"** is two-way: the issuer's account domain (D4), and that domain's toml (D4's store) has a `[[CURRENCIES]]` entry with the token's code and issuer that counts on this network (D4's `countsOn`). | As written. |
| 11 | **No node fallback** for a token the index lacks: 404 `token not found` (the explorer adds a coverage note). `gateway_balances` is heavy for big issuers and gives no holders. | As written. |
| 12 | **Transfers** are the payments that delivered the token (`payments_by_currency`), payments to oneself left out as in `/v2/payments`. | As written. |
| 13 | **Holder shares** are fractions of the supply with 6 decimals, rounded half up (`"0.117300"`). | As written. |
| 14 | **No supply or holders history** (the board's two charts): they need a daily statistics job, deferred by the owner. | Deferred. |
| 15 | **A new ADR** (the next number) for the touch index and the generations; ADR-0010 gains items for the four routes. | As written. |
| 16 | **Coverage is D3's `FeatureCoverageService`**, with D3's case of a feature without an amendment (trust lines, payments): its start is the network's first ledger, `NetworkProfile.firstLedger` (§6). Consistency pass: D3 defines that case (it builds the service first); D6 adds nothing to it. | As written. |

## Goal

Every element of the Tokens and Token boards that real data can fill reads one documented field of one call: the issued tokens of
the network ranked by holders, with supply, price, 24 h volume and the toml listing; one token with its issuer's settings, its toml
entry, its markets, its top holders and its recent transfers. Reads are milliseconds: no answer groups a trust line history.

## Scope and non-goals

In scope: the touch index and its parser output; the `tokens` aggregator job and three aggregate tables; `GET /v2/tokens`,
`GET /v2/tokens/{currency}.{issuer}`, `…/holders`, `…/transfers`; the `coverage` field; docs and tests.

Not in scope:
- Supply and holders over time (owner's cut: a new daily statistics job). Nothing here stores a per-day series.
- MPTs: D9 adds `kind=mpt` to the list (§8) and its own routes.
- A token's history of settings, a per-holder history, rich lists of one token over time.
- Token prices against anything but the native currency, prices for tokens without a native pair, and display currencies.
- Fetching tomls: D4's `tomls` worker fetches every account domain's toml (issuers included) and parses it; D6 reads D4's store.
- Names of issuers and holders: the explorer's one names call (`/v2/account_names`, D4).

## 1. Definitions

A trust line between accounts A and B in currency C has a balance from each side (`trust_line_states` holds both). From A's side,
a balance below 0 means A owes B: B holds A's token (C, A). For the token (C, I) and the other account H of a line:

| Term | Rule, from the issuer's side of the line |
|---|---|
| H **holds** (C, I) | the balance is below 0; H's balance is its negation |
| the line **counts** for (C, I) | H holds it, or the balance is 0 and H's limit (`limit_peer`) is above 0 |
| **holders** | the lines that count with H's balance above 0 |
| **trust lines** | the lines that count (zero balances included) |
| **supply** | the exact sum of the holders' balances: the issuer's obligations, as rippled's `gateway_balances` gives them |

So `trust_lines − holders` is the number of zero-balance lines. A line with both limits above 0 and a zero balance counts for both
sides' tokens. A frozen line counts. An AMM pool's reserve line counts: the pool is a holder. A line in an LP-token currency
(`^03[0-9A-F]{38}$`) counts for nothing. A **token** is a (C, I) with at least one line that counts.

## 2. Data model

One new migration (the next number) with four `CREATE TABLE IF NOT EXISTS`; `Table` gets `StateTouches`, `TokenGenerations`,
`TokenLines`, `Tokens`; `rows.ts` their row types. 55 tables become 59.

### 2.1 `state_touches` (ledger table, P6)

```sql
CREATE TABLE IF NOT EXISTS state_touches
(
  ledger_index UInt32,
  tx_index     UInt32,
  kind         Enum8('line' = 1, 'account' = 2),
  account      String,
  counterparty String,
  currency     LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, kind, account, counterparty, currency)
SETTINGS non_replicated_deduplication_window = 1000;
```

One row per state change the token aggregate depends on, in the order of the ledgers: a narrow index of `trust_line_states` and
`account_states` by ledger, as `amm_pool_touches` is of `amm_pool_states`. A `line` row is a trust line: `account` its low account,
`counterparty` its high one, `currency` as the ledger writes it. An `account` row is an account whose token settings may have
changed: `counterparty` and `currency` are `''`. In `CHILD_TABLES` and `LEDGER_KEYED_TABLES` (the e2e suite checks the partitioning),
deleted by recovery and `--reprocess` with the other child tables. About one row per changed RippleState node: on XRPL some millions a
day (to measure in the plan), small and compressed like `amm_pool_touches`.

**Why a table.** The job must find, every minute, the lines and issuers changed since its cursor. `trust_line_states` and
`account_states` are ordered by account (P7, about 15 months a partition): a ledger range is no key range, and the merged part that
holds the newest ledgers would be read whole every tick. Reading `transactions.meta_json` of the new ledgers and parsing it in the
job needs no ingest change, but costs megabytes a tick and gigabytes for a day of catch-up or a reprocessed range; the touch table
costs a narrow row per change and a key range read.

### 2.2 `token_generations` (aggregate, the job's state)

```sql
CREATE TABLE IF NOT EXISTS token_generations
(
  generation     UInt32,
  state          Enum8('building' = 1, 'live' = 2, 'retired' = 3),
  config_version UInt16,
  coverage_from  UInt32,
  head_ledger    UInt32,
  account_cursor String,
  pass_done      UInt8,
  through_ledger UInt32,
  repair_from    UInt32,
  holders        UInt32,
  holders_ledger UInt32,
  started_at     DateTime64(3, 'UTC'),
  changed_at     DateTime64(3, 'UTC'),
  version        UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY generation;
```

One row per change of a generation's state; the newest row of a generation (`ORDER BY generation, version DESC LIMIT 1 BY
generation`) is its state. `coverage_from` is the state coverage start the generation was built on (§6); `head_ledger` the ledger
its account pass reads at; `account_cursor` the last account the pass finished (`''` before the first); `through_ledger` the ledger
up to which every touch has been applied; `repair_from` the lowest ledger to apply again (0: none, §3.5); `holders` the distinct
holders of all tokens at `holders_ledger` (§3.6). **The live generation** is the highest `generation` whose newest row is `live`.

### 2.3 `token_lines` (aggregate)

```sql
CREATE TABLE IF NOT EXISTS token_lines
(
  generation   UInt32,
  issuer       String,
  currency     LowCardinality(String),
  holder       String,
  balance      String,
  balance_f    Float64,
  limit        String,
  frozen       UInt8,
  authorized   UInt8,
  ledger_index UInt32,
  deleted      UInt8,
  version      UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY generation
ORDER BY (issuer, currency, holder);
```

The current state of every line that counts (§1), from the token's side: `balance` is the holder's (0 or above, exact), `limit` the
holder's limit, `frozen` and `authorized` the issuer side's freeze and auth flags (`freeze`, `authorized` of the issuer's row),
`ledger_index` the ledger of the line's newest state. `deleted = 1` is a tombstone: the line no longer counts (deleted, emptied with
no limit, or turned round). Readers keep the newest version of each key (`ORDER BY holder, version DESC LIMIT 1 BY holder` inside the
token's prefix) and drop tombstones after that, never `FINAL`. A version is the ClickHouse clock in milliseconds, at least one more
than the key's newest. On XRPL some millions of rows a generation (the network's RippleState count; to measure).

### 2.4 `tokens` (aggregate)

```sql
CREATE TABLE IF NOT EXISTS tokens
(
  generation    UInt32,
  issuer        String,
  currency      LowCardinality(String),
  code          String,
  holders       UInt32,
  trust_lines   UInt32,
  supply        String,
  supply_f      Float64,
  last_ledger   UInt32,
  issuer_ledger UInt32,
  issuer_flags  UInt32,
  transfer_rate UInt32,
  domain        String,
  listed        UInt8,
  name          String,
  toml          String,
  deleted       UInt8,
  version       UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY generation
ORDER BY (issuer, currency);
```

One row per token and recompute. `code` is the currency as text (§5.2), `''` when it has none. `supply` is exact (the `sumOf` rule
of `decimal.ts`, with its Float64 fallback); `supply_f` its shadow. `last_ledger` is the newest `ledger_index` of the token's lines.
The issuer's settings are those of its newest `account_states` row at the ledger the row was computed at: `issuer_flags` (the
AccountRoot `Flags`), `transfer_rate` (`TransferRate`, 0 when absent) and `issuer_ledger` (that row's ledger; 0 when the issuer has
no row in the state tables: its settings are unknown). `domain` is the issuer's account domain (D4's `accountDomainOf` of its
`account_domains` row, §3.7), `''` when none. `listed`, `name` and `toml` come from the issuer's domain's toml (§3.7): `toml` is the
JSON of the served fields of the matched `[[CURRENCIES]]` entry, `''` when not listed. `deleted = 1`: no line counts any more.
Readers keep the newest version per (issuer, currency) and drop deleted rows after it. On XRPL about 10⁵ rows a generation (the board's
"49,490"; to measure). The key serves a token's point read and an issuer's prefix (§3.4).

## 3. The aggregate: the `tokens` job

A runner of its own, `TokensJobRunner` (`apps/syncer/src/aggregator/tokens.job-runner.ts`), with the shared work in
`packages/shared/src/aggregate/tokens.job.ts`, behind `AggregatorJobContext`. Job `tokens`, budget `AGGREGATOR_TOKENS_BUDGET_MS`
(4 s), in the tick after `markets_live` and before `stats_live`; enabled with an aggregator option `tokens` (on by default). Only
committed ledgers are read (the newest `ledgers` row is the head). Each step is idempotent and moves its cursor only after its rows are
written; a shutdown aborts before the next write; a failure is logged and counted (`syncer_aggregator_errors_total{job="tokens"}`) and
retried at the next tick. Constants: `TOKENS_CONFIG_VERSION` (1; a bump builds a new generation), `TOKENS_PASS_ACCOUNTS` (500),
`TOKENS_TOUCH_WINDOW` (500 ledgers, halved while a window holds more than 20,000 distinct lines), `TOKENS_STATE_CHUNK` (2,000 lines per
read: the keys travel as query parameters in the URL, ADR-0012's lesson), `TOKENS_HOUSEKEEPING_EVERY_TICKS` (10),
`TOKENS_RETIRED_KEEP_MS` (15 minutes).

**A tick**, in order, each step until the budget is spent:

1. apply the touches after the live generation's `through_ledger` (§3.2);
2. the live generation's repair, when `repair_from` is set (§3.5);
3. every `TOKENS_HOUSEKEEPING_EVERY_TICKS`: the rebuild check (§3.3), the distinct holders (§3.6) and the toml sweep (§3.7);
4. the building generation, if any: its account pass (§3.1), then its touches from `head_ledger`, then its promotion (§3.3);
5. drop the partitions of generations retired more than `TOKENS_RETIRED_KEEP_MS` ago (`ALTER TABLE … DROP PARTITION` on
   `token_lines` and `tokens`).

### 3.1 The account pass (a new generation)

A generation starts with a row `building`, `head_ledger` = the head, `coverage_from` = the state coverage start (§6). The pass walks
the issuers in key order, `TOKENS_PASS_ACCOUNTS` at a time:

1. The next accounts: `SELECT account FROM trust_line_states WHERE account > {cursor} ORDER BY account LIMIT 1 BY account LIMIT
   {n}` (key order, stops after `n`).
2. Server-side, `INSERT INTO token_lines SELECT …` from the newest row of each (account, counterparty, currency) of those accounts at
   or before `head_ledger` (the read of `TrustLinesService`, without its ledger-specific filters), keeping the rows where the line is
   not deleted, the currency is not an LP token's, and the line counts for the account's own token (§1, the account as issuer):
   `issuer = account`, `holder = counterparty`, `balance` negated. Each line appears once, from its issuer's side, so both
   orientations of a line come from its two accounts.
3. The token rows of those issuers: one grouped read of the new rows (`GROUP BY issuer, currency`: `countIf(balance_f > 0)`,
   `count()`, the exact sum, `max(ledger_index)`), the issuers' newest `account_states` rows at or before `head_ledger` (a prefix read
   each), the toml match (§3.7), written in one insert.
4. `account_cursor` moves to the last account of the batch.

An issuer with millions of rows is one statement of seconds; it is not split. When the cursor passes the last account, `pass_done`
is 1 and the generation applies the touches after `head_ledger` (§3.2) until it is promoted.

### 3.2 Applying touches (both generations)

For a generation at `through_ledger` T, with the head H:

1. The window (T, W], W ≤ H; every ledger in it must be written by `TOKEN_PARSER_VERSION` or later (`min(parser_version)` of the
   window's `ledgers` rows). A ledger of an older parser means touches are missing: the generation stops and a new one is started
   (§3.3); the live one keeps serving until it is replaced.
2. `SELECT DISTINCT kind, account, counterparty, currency FROM state_touches WHERE ledger_index > T AND ledger_index <= W` (a key range).
3. Lines (LP currencies dropped), in chunks of `TOKENS_STATE_CHUNK`: the newest row of each from its low account's side, at or before
   W (`(account, counterparty, currency) IN {lines}`, a prefix of the key each, `LIMIT 1 BY` the line). From it, both orientations:
   the token of the high account (holder: the low account, balance as stored) and the token of the low account (holder: the high
   account, balance negated, limit `limit_peer`). For each, the wanted `token_lines` row (or none), compared with the newest row of that
   key: a new row when it differs, a tombstone when a live row no longer counts.
4. The tokens to recompute: **every** token of the window's lines, both orientations, changed or not (so a crash between steps 3 and
   5 is repaired by doing the window again), and every token of each `account` touch's issuer (the issuer's prefix of `tokens`).
5. Their rows: the grouped read of §3.1 step 3 over their prefixes, the issuers' newest `account_states` rows at or before W, the
   toml fields the token rows have (or a match, for a token without a row). A token with no live line left gets a deleted row.
6. A new generation row with `through_ledger` = W.

A minute of XRPL ledgers is a few thousand lines and a few hundred tokens; a big token's recompute reads its prefix of `token_lines`
(hundreds of thousands of rows, tens of milliseconds).

### 3.3 Generations: rebuild and promotion

A new generation (`generation` = the highest + 1) is started when there is no live one, when the live one's `config_version` is not
`TOKENS_CONFIG_VERSION`, when the state coverage start (§6) is not its `coverage_from` (the history was filled further back, or a range
was written again by an older parser), or when its touches cannot go on (§3.2). One generation builds at a time; while it does, the
live one keeps being updated and served. A building generation is **promoted** once its pass is done and its `through_ledger` is at
least the live one's (or within 10 ledgers of the head when there is no live one): a row `live` for it, then a row `retired` for the
old one. Readers that take the highest live generation switch at the first row; the old partition is dropped 15 minutes later.
A generation is a version set in the sense of the codebase: one unit, read whole, never mixed with another.

### 3.4 The issuer's settings

From the issuer's newest `account_states` row: the flags by name with `accountFlagsOf(profile)` (XRPL and Xahau name the bits
differently; `AllowTrustLineClawback` is `0x80000000` on XRPL and `0x1000` on Xahau), served as `global_freeze` (`GlobalFreeze`),
`no_freeze` (`NoFreeze`), `allow_trust_line_clawback` (`AllowTrustLineClawback`), `require_auth` (`RequireAuth`) and
`default_ripple` (`DefaultRipple`); the transfer fee from `TransferRate` (`(rate − 1,000,000,000) / 10,000,000` percent, exact; 0 and
1,000,000,000 are no fee); and the account domain (§3.7). They change only through `AccountSet`, whose `AccountRoot` change is an
`account` touch (§4), which also recomputes the domain and the listing.

### 3.5 Re-ingest: the `agg_dirty` hook

`ofSlice(start, end)` (called by `stats_dirty` for each slice, as the other runners' hooks) does no work: it sets `repair_from` of
every generation whose `through_ledger` is at or above the slice's first ledger to the lower of its value and that ledger, and writes
the generation row. The repair step applies the touches of `[repair_from, through_ledger]` again, by windows, moving `repair_from` up;
it is §3.2 without step 6's cursor move. Applying a window twice is harmless (the newest state is re-read). A slice below the
generation's `coverage_from` is left to the rebuild check (a backfill moves the coverage).

### 3.6 Distinct holders

Every `TOKENS_HOUSEKEEPING_EVERY_TICKS`: `uniqExact(holder)` over the live generation's live rows with `balance_f > 0`, written to the
generation row with `holders_ledger` = its `through_ledger`. Some millions of rows, under a second.

### 3.7 The toml listing

D4 (`2026-10-24-display-names-design.md` §1.2, §3, §8) owns the per-domain toml store, `domain_tomls`: its `tomls` worker fetches the
toml of every account domain, so every token issuer's domain is in it with no fetch source of D6's. D6 reads it only through D4's
interfaces, with D4's names:

- **The issuer's account domain**: D4's `accountDomainOf(hex)` of the issuer's current `account_domains` row (`argMax(domain_hex,
  version)`, one keyed read for the issuers of a batch), lower case, `''` when the issuer names none or names no proper domain.
- **The domain's toml**: `readStoredTomls(ch, domains)` (`packages/shared/src/tomls/toml-store.ts`: the newest row of each domain,
  one read by key; D6 asks for at most 2,000 domains at a time) gives `toml_url` and the `[[CURRENCIES]]` entries in effect (`code`,
  `issuer`, `network`, `fields`), as D4's writer cleaned them (`cleanTomlText`: `code` at most 40, field texts at most 256 code
  points). A domain whose toml failed beyond its grace has no entries, so nothing is listed.
- **Which entries count on this network**: D4's `countsOn(entry.network, profile)` (`''` or one of D4's `profile.tomlNetworkNames`).

An entry **matches** a token when it counts on this network, its `issuer` is the token's issuer (D4 stores `''` for an issuer that is
not a valid address: no match), and its `code` is the token's currency once both are in the ledger's form (a 3-character code
upper-cased; a text of 4 to 20 characters as its 40 hex digits, zero-padded; 40 hex digits upper-cased; anything else matches
nothing). The first matching entry in file order wins. `listed` is 1 when the issuer's account domain has a matching entry; `name` is
its `fields.name` (text); `toml` holds the served fields of §5.2 taken from `fields` with D4's type rule for `/v2/toml/{domain}`
(`display_decimals` an integer 0 to 30, the others text), anything else left out. The entry is read only from
the issuer's own account domain: an entry in another domain's toml does not list the token. A URL among the fields is text, never
fetched.

The token rows get these fields when they are computed (§3.1, §3.2) and, every `TOKENS_HOUSEKEEPING_EVERY_TICKS`, the **sweep**
compares them with the store for every live token (the newest rows' `issuer, currency, domain, listed, name, toml`, the issuers'
account domains, and `readStoredTomls` of their distinct domains, matched in the job) and rewrites the rows that differ. A toml change
shows within D4's schedule plus ten minutes. The api never reads the store for tokens: the answers serve the token rows
(`DomainTomlsService.get(domain)` stays D4's route's and the account page's).

### 3.8 Metrics

| Metric | |
|---|---|
| `syncer_tokens_live` | 1 when a live generation exists. Gates the explorer's `TOKENS` switch |
| `syncer_tokens_lag_ledgers` | head − the live generation's `through_ledger` |
| `syncer_tokens_building` | 1 while a generation builds; its progress (the account cursor) is logged at each batch |
| `syncer_tokens_repair_ledgers` | `through_ledger − repair_from` of the live generation, 0 without a repair |

Alert: `syncer_tokens_lag_ledgers > 300` for 15 minutes.

## 4. Parsing: `state_touches`

Written by a new `StateTouchesParser` (`packages/shared/src/parsers/state-touches.parser.ts`), pure, from the same nodes as the two
state parsers, for every transaction whatever its result:

- **`line`**: every `RippleState` node that is created, deleted, or modified with `PreviousFields` (the rule of `trust_line_states`:
  a node only threaded changed nothing). `account` = `LowLimit.issuer`, `counterparty` = `HighLimit.issuer`, `currency` =
  `Balance.currency` of the final (or new) fields. One row per node; LP currencies are written too (the job drops them).
- **`account`**: an `AccountRoot` node that is created, deleted, or modified with `Flags`, `TransferRate` or `Domain` among its
  `PreviousFields`. A balance or sequence change makes no row.

A transaction touches a node at most once, so the key `(ledger_index, tx_index, kind, account, counterparty, currency)` is unique.
`PARSER_VERSION` moves to a new version, and `TOKEN_PARSER_VERSION` (in `rows.ts`) is that version, D3's gate pattern
(`NFT_PARSER_VERSION`): the gate compares with the feature's constant, never with `PARSER_VERSION`. A ledger written before it has no
touches, and the job never applies a window that holds one (§3.2). No amendment is relied on: trust lines and the five account flags are as old as
the networks, except `AllowTrustLineClawback` (XRPL Clawback, 2024; Xahau has its own bit), which is read by name and is simply false
before. DeepFreeze (XRPL) and the reserve and AMM bits of a line change nothing here.

## 5. Endpoints

A module `tokens` (`apps/api/src/tokens/`): `TokensController` (the four routes, in this order: the list, `:token/holders`,
`:token/transfers`, `:token`), `TokensService` (the generation, the list, the detail), `TokenHoldersService`, `TokenTransfersService`
(the payments read of `PaymentsService` by currency), `TokenMarkets` (§5.5), objects and CSV rows with their key orders in
`token-objects.ts`, the path parser in `token-param.ts`. Every answer carries the global `Cache-Control` (`private, max-age=60`); the
contract layer of every route (API key, rate limit, `{result:"error", message}`, unknown parameters ignored). An extra of this API:
ADR-0010 gains an item per route (new routes; their objects and key orders are ours).

**Reading the live generation.** One read of `token_generations` (newest row per generation), kept 5 s in `CacheService`: the live
generation, its `through_ledger` (whose `close_time` the answers name) and `holders`. Every read of `tokens` and `token_lines` has
`generation = {g}` (one partition).

### 5.1 `GET /v2/tokens`

| Parameter | Default | Meaning |
|---|---|---|
| `kind` | `issued` | The kind of token. Anything else: 400 `invalid kind - use: issued` (D9 makes it `issued, mpt`). |
| `min_holders` | 0 | Only tokens with at least this many holders: plain digits, 0 to 1,000,000,000, else 400 `invalid min_holders`. |
| `q` | | A search, trimmed, 1 to 64 characters (else 400 `invalid search`; empty is none): see below. |
| `limit` | 200 (max 1000) | |
| `marker` | | |
| `format` | json | `csv`: file `tokens.csv`, the rows flattened. |

**Order**: `holders` descending, then `issuer`, then `currency`. `rank` is the row's place in that order among the tokens the filters
select (1-based). The marker holds `(holders, issuer, currency)` of the last row, as `/v2/amm/pools` holds its value and account
(`amm-paging.ts`, Ruling R-A4); the ranking is rebuilt each minute, so a token can move between pages from one minute to the next.

**Search**: `q` a classic address: the tokens of that issuer. Otherwise a token matches when its `code`, `name` or `domain` contains
`q` (case-insensitive), its currency is `q` (40 hex digits, any case), or its issuer starts with `q`.

**Counts**: `total`, the number of tokens the filters select (all pages; D3's word for the same count of collections);
`total_below`, when `min_holders` is above 0, the number that match `q` (or all tokens without `q`) but have fewer than `min_holders`
holders: the board's "Show all (48,206 hidden)" and "3 more among tokens with fewer than 10 holders". `totals` describe the whole
kind, whatever the filters: `tokens` (every token), `tokens_with_10_holders`, `holders` (the generation's distinct holders, §3.6) and
`native_volume` (the `day` markets set's `total_native_volume`, every pair: absent while there is no set).

```json
{
  "result": "success",
  "coverage": { "from_ledger_index": 99640001, "complete": false },
  "kind": "issued",
  "ledger_index": 107721455,
  "close_time": "2026-10-24T14:03:01Z",
  "totals": { "tokens": 49490, "tokens_with_10_holders": 1284, "holders": 612480, "native_volume": "58400000" },
  "total": 1284,
  "total_below": 48206,
  "count": 1,
  "marker": "…",
  "tokens": [{
    "rank": 1, "currency": "4E50555344000000000000000000000000000000", "code": "NPUSD", "issuer": "r…",
    "holders": 48920, "trust_lines": 61207, "supply": "182402118.55",
    "price": "0.41010000", "price_change": "0.12", "price_time": "2026-10-24T14:02:51Z", "native_volume": "9820000", "trades": 2140,
    "domain": "northpeak.example", "listed": true, "name": "Northpeak Dollar"
  }]
}
```

Keys: answer `result, coverage, kind, ledger_index, close_time, totals, total, total_below?, count, marker?, tokens`; totals
`tokens, tokens_with_10_holders, holders, native_volume?`; row `rank, currency, code?, issuer, holders, trust_lines, supply, price?,
price_change?, price_time?, native_volume?, trades?, domain?, listed, name?`. **No generation yet**: `{ "result": "success",
"coverage": …, "kind": "issued", "count": 0, "tokens": [] }` (the markets route's rule). Errors, in order: 400 `invalid kind - use: issued`, `invalid
min_holders`, `invalid search`, `invalid marker`; 500 `unable to retrieve tokens`.

The read: the generation's newest rows (`ORDER BY issuer, currency, version DESC LIMIT 1 BY issuer, currency`), `deleted = 0`, the
filters, `row_number()` over the order, then the marker and `LIMIT n + 1`; the counts are one more grouped read of the same rows. Both
read one partition of about 10⁵ rows. The page is then given its price and volume (§5.5).

### 5.2 `GET /v2/tokens/{currency}.{issuer}`

**The path.** One segment, split at its **last** `.`, `+` or `|` (an address has none, so a text code may hold one): the code before,
the issuer after. The code is a 3-character code (upper-cased, as the payments routes do), 40 hex digits (any case; one that is the
ledger's standard form of a 3-character code is that code), or a text of 4 to 20 printable characters (as its 40 hex digits,
zero-padded). `code` in answers is the reverse: the 3-character code, or the hex's text when its bytes, trailing zeros dropped, are
printable ASCII; absent otherwise. The network's native code with an issuer is 400 `XRP cannot have an issuer` (`XAH` on Xahau), as
in `asset-param.ts`; on Xahau an issued `XRP` is a currency like any other.

```json
{
  "result": "success",
  "coverage": { "from_ledger_index": 99640001, "complete": false },
  "ledger_index": 107721455,
  "close_time": "2026-10-24T14:03:01Z",
  "token": {
    "currency": "4E50555344000000000000000000000000000000", "code": "NPUSD", "issuer": "r…",
    "holders": 48920, "trust_lines": 61207, "supply": "182402118.55",
    "price": "0.41010000", "price_change": "0.12", "price_time": "2026-10-24T14:02:51Z", "native_volume": "9820000", "trades": 2140,
    "domain": "northpeak.example", "toml_url": "https://northpeak.example/.well-known/xrp-ledger.toml", "listed": true,
    "toml": { "name": "Northpeak Dollar", "desc": "A US dollar stablecoin…", "display_decimals": 2,
              "asset_class": "Fiat-backed stablecoin", "attestation": "https://northpeak.example/attestations/2026-09.pdf" },
    "issuer_settings": { "transfer_fee": "0", "global_freeze": false, "no_freeze": false, "allow_trust_line_clawback": true,
                         "require_auth": false, "default_ripple": true },
    "markets": [{ "counter_currency": "XRP", "count": 1402, "volume": "17361000", "counter_volume": "7120000",
                  "native_volume": "7120000", "last": "0.41010000", "change": "0.12", "last_time": "2026-10-24T14:02:51Z",
                  "amm_pool": true }],
    "last_ledger": 107721451
  }
}
```

Keys: answer `result, coverage, ledger_index, close_time, token`; token `currency, code?, issuer, holders, trust_lines, supply,
price?, price_change?, price_time?, native_volume?, trades?, domain?, toml_url?, listed, toml?, issuer_settings?, markets,
last_ledger`; `toml` `name?, desc?, icon?, symbol?, display_decimals?, asset_class?, asset_subclass?, attestation?` (the fields of the
xrp-ledger.toml reference and of the XLS-26 draft the boards use, each as the toml gives it, a string, or a whole number for
`display_decimals`; others are not served); `issuer_settings` `transfer_fee, global_freeze, no_freeze, allow_trust_line_clawback,
require_auth, default_ripple`, absent while the issuer has no row in the state tables (`issuer_ledger` 0); market (§5.5)
`counter_currency, counter_issuer?, count, volume, counter_volume, native_volume?, last, change?, last_time, amm_pool?`.
`toml_url` is `https://{domain}{profile.tomlPath}`, the `toml_url` D4's store has for that domain. No CSV.

Errors, in order: 400 `invalid currency`, `XRP cannot have an issuer` (`XAH`), `invalid issuer address`; 404 `token not found` (no
live row: no line counts, an LP token, a token whose lines have not changed since the coverage start, or no generation yet); 500
`unable to retrieve token`. The read: one point read of the generation's partition (`issuer = … AND currency = … ORDER BY version
DESC LIMIT 1`).

### 5.3 `GET /v2/tokens/{currency}.{issuer}/holders`

| Parameter | Default | Meaning |
|---|---|---|
| `limit` | 200 (max 1000) | |
| `marker` | | |
| `format` | json | `csv`: file `<code or currency> <issuer> - holders.csv`. |

The token's lines with a balance above 0, by balance descending, then holder; `rank` as in the list. The marker holds `(balance_f,
holder)` of the last row. `share` is the balance over the token's supply, exact, rounded half up to 6 decimals.

```json
{
  "result": "success", "coverage": { "from_ledger_index": 99640001, "complete": false },
  "ledger_index": 107721455, "close_time": "2026-10-24T14:03:01Z",
  "supply": "182402118.55", "count": 1, "marker": "…",
  "holders": [{ "rank": 1, "holder": "r…", "balance": "21395768.51", "share": "0.117300", "limit": "1000000000",
                "frozen": false, "authorized": false }]
}
```

Keys: answer `result, coverage, ledger_index, close_time, supply, count, marker?, holders`; row `rank, holder, balance, share, limit,
frozen, authorized`. Errors: the path's 400s, `invalid marker`; 404 `token not found`; 500 `unable to retrieve holders`. The read:
the token's prefix of `token_lines` in the generation (its lines and their versions), the newest row per holder inside, the filter,
the order and `row_number()` outside, then the marker and `LIMIT n + 1`.

### 5.4 `GET /v2/tokens/{currency}.{issuer}/transfers`

The payments that delivered the token: `payments_by_currency` for the token's currency and issuer, read by `PaymentsService`'s
by-currency read (`readDistinctPage`, the key `(ledger_index, tx_index)`), with `/v2/payments`' window parameters and their messages:
`start`, `end`, `descending` (default false, as every list here), `limit` (200, max 1000), `marker`, `format` (`csv`: file `<code or
currency> <issuer> - transfers.csv`). The issuer is that of the delivered amount (the payment parser resolves an `Amount` that names
a party as its issuer); a payment to oneself is not a payment (ADR-0010 item 66).

```json
{ "result": "success", "coverage": { "from_ledger_index": 32570, "complete": true }, "count": 1, "marker": "…",
  "transfers": [{ "hash": "…", "ledger_index": 107721440, "executed_time": "2026-10-24T14:02:51Z", "source": "r…",
                  "destination": "r…", "amount": "1250", "destination_tag": 12 }] }
```

Keys: answer `result, coverage, count, marker?, transfers`; row `hash, ledger_index, executed_time, source, destination, amount
(the delivered amount), source_tag?, destination_tag?`. The coverage is the feature `token_transfers` (the ledger tables, §6), not
the state tables'. Errors: the path's 400s, then `/v2/payments`' (`invalid start date format`, `invalid end date format`, `invalid
marker`); 500 `unable to retrieve transfers`. A token the aggregate does not know still lists its transfers (no 404).

### 5.5 Price, volume and markets (`TokenMarkets`)

Read from the newest `include` sets of `markets_live` for `day` and `30day` (`MarketsService`'s set read), kept 30 s in memory as a
map from asset to its pairs. Native volumes are those of the set (trades with a native leg above 0.0005).

- **`markets`** (the detail): every pair of the `day` set with the token on a side, **turned so the token is the base**: `volume` the
  token's side, `counter_volume` the other, `last` the other asset per token (the stored rate, or its inverse with 200 decimal places,
  then 8 significant digits), `change` from `open` and `last` in that orientation (2 decimals, half up), `native_volume` and `count` as
  stored, `amm_pool` when the set has it. Ordered by `native_volume` descending (none last), then `count`, at most 20.
- **`price`**: `last` of the token's pair against the native currency in the `day` set, turned to native per token, with
  `price_change` and `price_time` (`last_time`); else that pair's `last` in the `30day` set, with `price_time` and no change; else
  absent.
- **`native_volume`** and **`trades`**: the sums over the `day` set's pairs with the token (`native_volume` over those that have one);
  `"0"` and 0 when it has none; absent when there is no `day` set.

## 6. Coverage

Every answer above carries D3's shape, right after `result`: `"coverage": { "from_ledger_index", "complete" }`, from D3's shared
`FeatureCoverageService` (`apps/api/src/common/feature-coverage.service.ts`, D3 `2026-10-17-nft-data-design.md` §4), which D6 uses and
does not redefine. Its rule: `from_ledger_index` is one more than the newest stored ledger a parser older than the feature's
`parserVersion` wrote, else the oldest stored ledger (D3's shared helper `newestLedgerBelowVersion`, which `StateLedgerService` also
moves onto); `complete` is `from_ledger_index` at or below the feature's start ledger; both kept 60 s (`FEATURE_COVERAGE_CACHE_MS`);
with no stored ledger, `from_ledger_index` is left out and `complete` is false. Not in the CSV.

D6 registers two features:

| Feature | `parserVersion` | Start ledger | Answers |
|---|---|---|---|
| `issued_tokens` | `STATE_PARSER_VERSION` (the state tables the aggregate is built from) | the network's first ledger | the list, the detail, the holders |
| `token_transfers` | 1 (every stored ledger has its payments) | the network's first ledger | the transfers |

Trust lines need no amendment, so these two are registered without one, **D3's case of a feature without an amendment** (D3 §4): the
start is the network's first ledger, `NetworkProfile.firstLedger` (XRPL 32570, Xahau its genesis ledger, none on the testnets, which
therefore answer `complete: false`). D6 adds nothing to the service.
For `issued_tokens`, `complete` also means the state tables hold the state of that first ledger: the history spec's fill back to
32570. A line that has not changed since `from_ledger_index` is not known, so its holder, its token or its issuer's settings may be
missing. The generation's `coverage_from` is the same value (`newestLedgerBelowVersion`), read by the job to notice a change of the
start (§3.3); the answers read the service.

## 7. Query bounds

What the plan's tests pin (`expectBoundedInOrderRead`, `read_rows`, `EXPLAIN indexes = 1`):

| Read | Bound |
|---|---|
| list, counts | one partition of `tokens` (the live generation): `read_rows` at most its rows plus a granule per part |
| detail | the point key in one partition: at most a few granules |
| holders | the token's key prefix in `token_lines`: `read_rows` at most its rows and versions plus a granule per part, never another token's |
| transfers | `payments_by_currency` by `readDistinctPage`; added to `apps/api/test/paged-reads.e2e-spec.ts` |
| job: touches | a key range of `state_touches` |
| job: line states | `(account, counterparty, currency) IN …`: the primary key, granules of those prefixes only |
| job: token rows | the tokens' prefixes of `token_lines`; issuers' prefixes of `account_states` and `tokens` |
| job: account pass | a key range of `trust_line_states` by account |

## 8. The MPT kind (D9)

`kind` is in the list from the start, echoed in every answer, and part of the marker (a marker of one kind is `invalid marker` for
another). The answer's envelope (`coverage`, `kind`, `ledger_index`, `close_time`, `totals`, `total`, `total_below`, `count`,
`marker`, `tokens`), `min_holders`, `q`, `limit` and the order by holders are the same for every kind; the row and the `totals` of
each kind are its own. D9 adds `mpt` to the accepted values (and to the message), its row (issuance ID, ticker and name from the
metadata, holders, outstanding, maximum, flags, 24 h transfers), its totals and its search fields, and serves one issuance at
`/v2/mpt/{issuanceId}`; `/v2/tokens/{currency}.{issuer}` stays issued-only. `TokensController` dispatches the list by kind to a
service per kind.

## 9. XRPL, Xahau and the testnets

| | XRPL | Xahau |
|---|---|---|
| Native currency (prices, volumes) | XRP | XAH |
| Flag bits | the definitions' names | xahaud's table (`accountFlagsOf`): `AllowTrustLineClawback` is `0x1000` |
| AMM | swaps count in markets and volumes; LP tokens left out; `amm_pool` on markets | no AMM: no LP lines, `amm_pool` false once its ledgers are of parser 2 |
| Toml | `xrp-ledger.toml` | `xahau.toml` |
| Lines changed by | Payment, OfferCreate, TrustSet, AMM*, Clawback, CheckCash, EscrowFinish (TokenEscrow), Batch inner transactions | Payment, OfferCreate, TrustSet, Remit, Import, ClaimReward/GenesisMint, emitted transactions |

The parser and the job read the metadata's nodes, not the transaction types, so a type that changes a line is covered without a
list. The testnets (D-env's profiles) run the same code with D4's `tomlNetworkNames`; they have no `firstLedger` (D3 §4), so their
coverage is never complete (§6).

## 10. Backfill, re-ingest and rollout

- **No history re-ingest is needed** for the aggregate: the account pass reads `trust_line_states` as it is. The touches exist from the
  new parser version on, and the job needs them only after its generation's `head_ledger`.
- **Coverage follows the state tables** (PR #20's re-ingest rules, `docs/backfill.md`): filling them further back changes the coverage
  start, which builds a new generation (§3.3) and then serves the wider history.
- **A reprocessed range** reaches the job through `agg_dirty` (§3.5).
- **Rollout order**: `migrate` (the new migration: the syncer's ledger writer fails without `state_touches`), then the syncer (new
  parser; the job starts the first generation), then the api. The explorer's `TOKENS` goes on once `syncer_tokens_live` is 1 and the
  lag is small. Until the first generation is live, the list answers the no-generation answer and the detail 404.
- **Permissions**: the syncer's ClickHouse user needs `ALTER … DROP PARTITION` on `token_lines` and `tokens` (§3).
- **Duration of the first build**: the pass reads all of `trust_line_states` once; on a full XRPL history it takes hours under its
  4 s a tick (the plan measures it on the verification database and records it in `operations.md`).

## 11. Docs to update

- `docs/api-reference.md`: a section "Tokens" with the four routes (parameters, examples, keys, errors, coverage, the definitions of
  §1), the Compatibility list of extras, and the two coverage features under D3's "Coverage" convention (D3's no-amendment case).
- `docs/adr/0010-…`: an amendment with an item per route (extras), the definitions (holders, supply), `rank` and the moving-ranking
  marker, and transfers' relation to `/v2/payments`.
- A new ADR: issued tokens from the state history, a ledger-ordered touch index, and generations swapped whole.
- `docs/data-model.md` (the four tables, the counts, section 5's migration row), `docs/syncer.md` (the job, its place and budget,
  the hook), `docs/backfill.md` (`TOKEN_PARSER_VERSION`, no re-ingest needed), `docs/observability.md` and `docs/operations.md`
  (metrics, alert, a forced rebuild by bumping `TOKENS_CONFIG_VERSION`, the build's duration), `docs/architecture.md` (the job list,
  the module list), `docs/security.md` (the drop permission), `docs/openapi.yaml` regenerated.

## 12. Testing

**Unit.**
- `state-touches.parser.spec.ts`: a created, a modified (with and without `PreviousFields`) and a deleted RippleState; an
  `AccountSet` changing `Domain`, `TransferRate`, a flag; an account whose balance alone changed (no row); a failed transaction that
  touched a line (rows: metadata decides); key uniqueness; deep-frozen input.
- `build-rows` golden snapshot and the "every child table has rows" checks with the new table.
- `tokens.job.spec.ts`: orientation and counting (§1) on every sign and limit combination, both sides counting, LP currencies,
  tombstones, the issuer settings by network (a Xahau flag table), the toml match over `readStoredTomls` rows (3-character, text, hex codes; another
  issuer; an issuer D4 stored as `''`; `network` through `countsOn`; an entry in another domain's toml; a failed toml), the served
  fields' types, `code` decoding.
- `tokens.job-runner.spec.ts` (with fakes): the tick order and budget; the pass batches and its cursor across ticks; touches applied
  and the cursor moved only after the writes; a crash between lines and tokens repaired by the next run; an older-parser ledger in a
  window starts a generation; promotion and retirement; the housekeeping cadence; the hook sets `repair_from` and does nothing else.
- `token-param.spec.ts` (the path), `token-objects.spec.ts` (keys, absent fields, `share`, price turning, CSV rows).
- The no-amendment case of the coverage service is D3's and is tested there (`feature-coverage.service.spec.ts`); D6's e2e tests check
  its two features' answers on XRPL and Xahau.

**e2e (testcontainers, the seeded `LedgerWriter`).**
- `apps/syncer/test/tokens.e2e-spec.ts`: the oracle: holders, trust lines and supply of every token equal a brute-force computation
  from `trust_line_states` at the head; **an incremental generation equals a fresh one built at the same head**, row for row; a
  `--reprocess` of a range repaired through `agg_dirty`; a config bump builds and swaps a generation, the old partition dropped; LP
  lines absent.
- `apps/api/test/tokens.e2e-spec.ts`: every route's answer, keys and errors; the list's filters, search, `rank`, counts and totals;
  concatenated pages equal the unpaged list; CSV files; the no-generation answer; price and markets from seeded markets sets in both
  orientations; plan and `read_rows` tests of §7; transfers in `paged-reads.e2e-spec.ts`; Xahau's flag names.
- `apps/syncer/test/migrate.e2e-spec.ts`: the four tables' physical design; `LEDGER_KEYED_TABLES` with `state_touches`.

**Recorded fixtures to add** (`record:fixtures`, `packages/shared/test/fixtures/{xrpl,xahau}/recorded`): XRPL ledgers with an
`AccountSet` setting `Domain` and one setting `TransferRate`, an `AccountSet` setting `asfAllowTrustLineClawback`, a `TrustSet` that
deletes a line (back to defaults), a `TrustSet` with `tfSetfAuth`, a `Clawback`, an issued-token payment rippling through its issuer, an
`OfferCreate` crossing two issued-token lines, an `AMMDeposit` (LP line); Xahau ledgers with a `TrustSet` and an issued-token payment (EVR) and a
`Remit` of an issued token.
