# ADR-0019: Issued tokens from the state history, a ledger-ordered touch index, and generations swapped whole

**Status:** Accepted. Amends [ADR-0010](0010-ripple-v2-wire-compatibility.md#amendment-8-2026-10-30-issued-tokens) (Amendment 8, items 94 to 102). Applies
[ADR-0015](0015-historical-account-state-from-clickhouse.md)'s approach (state from the ClickHouse history, never from a node) to the issued tokens, [ADR-0016](0016-nft-and-uritoken-data.md)'s
coverage rule (`FeatureCoverageService`, with [ADR-0018](0018-ledger-object-history.md)'s case of a feature without an amendment) to two more features, and
[ADR-0017](0017-display-names.md)'s toml store to the listing of a token. The design is in [the issued tokens spec](../superpowers/specs/2026-10-24-issued-tokens-design.md), program 2
sub-project D6. Amended on 2026-10-31 (at the end of this record): its hook is no longer the last of a slice.

## Context
The explorer has a list of the tokens of the network ranked by holders, and a page for a token: its holders and supply, its price and volume, the settings of its issuer, what the
issuer's toml says of it, its biggest holders and its recent transfers. The index could answer none of it:

- **No count of holders exists anywhere.** `trust_line_states` (ADR-0015) holds every state a trust line has had, ordered by account: the holders of one token are spread over the whole
  table, so "who holds (C, I) now" and "how many tokens have 10 holders" are scans of years of history. The node's `gateway_balances` is heavy for a big issuer and gives no holders.
- **The state tables are ordered by account, not by ledger.** The job that keeps a token set current has to find, every minute, the lines and issuers that changed since its last run. A
  ledger range is no key range of `trust_line_states` or `account_states` (P7, about fifteen months a partition), and the merged part that holds the newest ledgers would be read whole every
  tick.
- **A token is made of other stores.** Its price and 24 hour volume are the markets aggregates', its settings the issuer's account state, its listing the toml store's.
- **MPTs come later** (D9) and share the list.

## Decision
1. **The tokens are computed from the state history, not from a node.** A token is a currency with its issuer and at least one trust line that counts (the definitions of the
   [reference](../api-reference.md#tokens): holders are the lines with a positive balance from the issuer's side, trust lines add the zero balances with a limit, supply is the exact sum of
   the holders' balances). LP tokens count for nothing. Three aggregates (migration 014) hold the result: `token_lines` (the current state of every line that counts, from the token's side),
   `tokens` (one row per token: holders, trust lines, supply, the issuer's settings and the listing) and `token_generations` (the state of the job). **There is no node fallback**: a token the
   index does not know is 404, and the explorer asks the node.
2. **A ledger-ordered touch index, `state_touches`** (ledger table, P6, parser version 8, `TOKEN_PARSER_VERSION`). The parser writes a row for each `RippleState` node that a transaction
   created, deleted or modified with `PreviousFields` (the rule of `trust_line_states`: it shares the walk, `changedTrustLines`) and for each `AccountRoot` whose flags, transfer rate or
   domain changed, plus the root of an `AccountSet`'s sender (a field set for the first time is not in `PreviousFields`). It is ordered by ledger, so the job reads "what changed since ledger T"
   as a key range, as `amm_pool_touches` and `nft_touches` do for their jobs. **Reading `transactions.meta_json` of the new ledgers instead** needs no ingest change, but costs megabytes a tick and
   gigabytes for a day of catch-up or a reprocessed range, and puts a second parser of the metadata in the job; the touch table costs a narrow row per change. The cost of the choice is a parser
   version: a ledger written before it has no touches, and the job never applies a window that holds one.
3. **Generations, built beside the live one and swapped whole.** The first build is an account pass over `trust_line_states` in key order (`TOKENS_PASS_ACCOUNTS` accounts a batch, in the 4 s
   budget of the job), which writes the lines server-side (`INSERT … SELECT`) and the token rows; the generation then applies the touches after its head until it is promoted. Afterwards the
   live generation is kept current from the touches of each window, and a **change of the rules, of the coverage, or a window met in an older parser starts a new generation**
   beside it. It is promoted once it has caught up (a `live` row for it, then a `retired` row for the old one), readers switch at the first row, and the old partitions are dropped 15
   minutes later. Every read names its generation, so a generation is one unit, never mixed with another. A generation is a partition (`PARTITION BY generation`) so that **dropping a
   retired one is `ALTER TABLE … DROP PARTITION`**, which is why the syncer's ClickHouse user needs `ALTER DELETE` (the privilege that statement asks for) on `token_lines` and `tokens` (today the full-access `data_api` user has it).
   A version is the runner's clock in milliseconds, above any stored one, and readers keep the newest row of each key (`LIMIT 1 BY`, never `FINAL`).
4. **A re-ingest reaches the job through `agg_dirty`.** The hook (the last of `hooksOfSlice`) only lowers `repair_from` of the live and the building generation; the next runs apply the touches
   of `[repair_from, through_ledger]` again, reading the state at `through_ledger`, so a line changed in the repaired window and again later keeps its later state. A window that meets a ledger
   of an older parser ends the repair and marks a rebuild: the program's one reprocess after its last parser version rebuilds the generation through this path.
5. **Price and volume are read at request time**, from the newest `markets_live` sets (`day`, `30day`, kept 30 seconds), not stored in the token rows: they would be stale by the minute and
   would need the job to depend on the markets jobs. The price is the last trade against the native currency in the `day` set, else in the `30day` set (without a change); the markets of a
   token are the pairs of the `day` set turned so that the token is the base.
6. **The toml listing is read from D4's store, two-way.** A token is `listed` when the toml of the issuer's own account domain (D4's `accountDomainOf` of `account_domains`) has a
   `[[CURRENCIES]]` entry that counts on the network (`countsOn`), names the issuer and has the token's code. The job matches it when it computes a token and every tenth run a **sweep** (resumable
   steps from a cursor, `GROUP BY` with `argMax` of the version) compares every live token with the store; the api never reads the store for tokens. D6 fetches no toml.
7. **Coverage is D3's, from the network's first ledger.** `issued_tokens` (the state tables, parser version 3) and `token_transfers` (the payments, parser version 1) are two features of
   `FeatureCoverageService` without an amendment: they start at `NetworkProfile.firstLedger` (32,570 on the XRP Ledger, Xahau's first ledger, none on a testnet, which is never complete). The
   generation's `coverage_from` is the same value, and a change of it builds a new generation.
8. **The list is ranked by holders**, with a `rank`, a marker that is a cursor into a ranking that moves each minute (as `/v2/amm/pools`), `kind` accepted and part of the marker (D9 adds
   `mpt` through the `TOKEN_LIST_SERVICES` map and changes nothing else), `totals` of the whole kind whatever the filters, and a search. Holders are paged by balance with ranks over the whole
   list. The transfers are the payments that delivered the token, read from `payments_by_currency` by the by-currency read of `/v2/payments`, with no 404.
9. **The routes are GateHub extras** (ADR-0010 Amendment 8). No supply or holders history is kept (a daily statistics job, deferred).

## Consequences
- **The first build is an hour to a few hours of 4 s ticks, once.** The account pass reads all of `trust_line_states` once, one tick a minute; the rate measured on synthetic data and the estimate for the XRP
  Ledger are in [operations](../operations.md#issued-tokens). While it builds the list answers the no-generation answer and the detail 404.
- **A parser version and a table of touches** (about 25 to 40 rows a ledger on the ledgers recorded so far, measured), kept by the P6 retention with the other ledger tables. The token tables
  are never dropped by retention: a rebuild after a drop is exact only for the lines whose last state is above the oldest kept block.
- **Complete coverage waits for the history fill** (ADR-0015's load from ledger 32,570, or one reprocess after the program's last parser version). Until then a trust line that has not changed since
  `from_ledger_index` is not known: its token, holder or issuer's settings can be missing, and `coverage` says so. Filling the history further back builds a new generation.
- **Answers are a few ledgers behind the head** (the job's lag; alert `syncer_tokens_lag_ledgers > 300` for 15 minutes), and a toml change shows within tens of minutes. The 15 minutes that a retired
  generation is kept cost its partitions' disk meanwhile.
- **A job that cannot read its tables stalls the hook for every job.** The hook of `tokens` is the last one of a slice and throws while the job has not read its version floor or its opening reads
  fail, so `agg_dirty` does not drain. A missing migration 014 cannot cause it: the syncer refuses to boot without the tables (the ingest needs `state_touches`, the aggregator all four), as it does
  without 002 or 012 for their workers ([operations](../operations.md#apply-a-schema-migration)). What is left is ClickHouse failing the job's opening reads ([operations](../operations.md#a-persistent-tokens_dirty)).
- **An issuer with millions of lines is one statement** of the pass (seconds, hundreds of megabytes: measured in [operations](../operations.md#issued-tokens)); the pass does not split it.

## Amendment (2026-10-31): the hook of `tokens` is no longer the last

Decision 4 and the consequence on a job that cannot read its tables call the hook of `tokens` the last of `hooksOfSlice`. Since D9 ([ADR-0020](0020-mpt-data.md)) the hook of `mpt_state` runs after it, so that is no longer so. Nothing else of those two passages changes: a hook that fails still fails the slice, the slice stays in `agg_dirty` and its hooks run again, so a `tokens` hook that throws holds back `mpt_state`'s hook of that slice as well.
