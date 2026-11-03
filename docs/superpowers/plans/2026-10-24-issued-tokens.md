# Issued Tokens (D6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the issued-token aggregate from PR #20's trust-line and account state, kept current by a ledger-ordered touch index and swapped in whole generations, and serve it at `GET /v2/tokens`, `GET /v2/tokens/{currency}.{issuer}`, `…/holders` and `…/transfers`, so that D9 adds `kind=mpt` additively.

**Architecture:** One migration (`014`) adds the ledger table `state_touches` and three aggregates (`token_generations`, `token_lines`, `tokens`, the last two partitioned by generation). A new pure parser writes one touch per changed trust line and per account whose token settings may have changed, behind `TOKEN_PARSER_VERSION`. A new aggregator runner, `TokensJobRunner`, builds a generation from `trust_line_states` (an account pass), keeps it current from the touches, repairs it from `agg_dirty`, swaps a rebuilt generation in whole and drops retired partitions. A new API module reads one partition of the live generation per answer, takes price and volume from the `markets_live` sets at request time, transfers from `payments_by_currency`, toml listings from the token rows (D4's store read by the job), and coverage from D3's `FeatureCoverageService`.

**Tech Stack:** TypeScript (strict), NestJS 10, ClickHouse 26.8 (`@clickhouse/client`), pnpm 10 workspace, jest + ts-jest, testcontainers, supertest, `bignumber.js`, `ripple-address-codec`.

**Spec:** `docs/superpowers/specs/2026-10-24-issued-tokens-design.md` (cited "spec §n"; the plan argues from the spec, executors read both). Specs it builds on, by name only: D3 `2026-10-17-nft-data-design.md` §2 and §4 (the parser gate, `FeatureCoverageService`, `newestLedgerBelowVersion`, `NetworkProfile.firstLedger`), D4 `2026-10-24-display-names-design.md` §1, §3, §8 (`account_domains`, `domain_tomls`, `accountDomainOf`, `readStoredTomls`, `countsOn`, `profile.tomlNetworkNames`), D9 `2026-10-17-mpt-data-design.md` §7.1 (what `kind=mpt` adds later).

**Branch:** `feat/explorer-data-2` in `DAPI = /Users/golobitch/github.com/GateHubNet/data-api-worktrees/explorer-data-2` (stacked on PR #20). D6 is built after D-env, D3, D4 and D5 on this branch, in that order. Nothing is pushed.

## Global Constraints

- **Before Task 1** confirm the earlier sub-projects are on the branch: `apps/api/src/common/coverage-features.ts` exports D3's registry `COVERAGE_FEATURES` (entries `{ parserVersion, startOf(profile): FeatureStart }`, `FeatureStart` `amendment` / `first_ledger` / `unavailable`) and `apps/api/src/common/feature-coverage.service.ts` `FeatureCoverageService.coverage(name: CoverageFeatureName)`; `packages/shared/src/tomls/toml-store.ts` exports `readStoredTomls`; `packages/shared/src/tomls/account-domain.ts` exports `accountDomainOf`; `countsOn` and `newestLedgerBelowVersion` are exported from `@gatehub/data-api-shared`; `NetworkProfile` has `firstLedger` and `tomlNetworkNames`; `Table.AccountDomains` and `Table.DomainTomls` exist. If any is missing, stop and report BLOCKED naming it.
- **Numbers (verify at build time, in the task that takes them):** migration `packages/shared/schema/014_issued_tokens.sql` (D5 took `013`); `PARSER_VERSION = 8` and `TOKEN_PARSER_VERSION = 8` (D5 set `OBJECT_PARSER_VERSION = 7`); ADR `docs/adr/0019-issued-tokens-from-state-history.md` (D3, D4, D5 took 0016–0018). If an earlier sub-project took more, take the next free value and change every reference in that task.
- `pnpm install --frozen-lockfile` once if the worktree has no `node_modules`. The apps import the compiled `dist/` of `packages/shared`: after changing shared, run `pnpm --filter @gatehub/data-api-shared build` before app tests. Docker is available for the e2e suites; if the `testcontainers/ryuk` pull fails, run them with `TESTCONTAINERS_RYUK_DISABLED=true` and say so.
- Before each commit: `pnpm format`, `pnpm build`, `pnpm test`, and `pnpm --filter <package> test:e2e` of every package the task touched (`@gatehub/data-api-shared`, `@gatehub/data-syncer`, `@gatehub/data-api-service`), all exit 0.
- Commits: Conventional Commits in the repo's style (`feat(shared): …`, `feat(syncer): …`, `feat(api): …`, `test: …`, `docs: …`), a body saying why, and the last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--amend`, never `git add -A` or `.` (name the files), never touch `.claude/`. Delete nothing you did not create.
- Repo conventions (`docs/development.md` §5): table names only from `Table`; every user-derived value a bound query parameter (a generation number, which the job makes, is checked with `Number.isInteger` and inlined only in `DROP PARTITION`, which takes no parameter); no `FINAL`; key-ordered reads; exact decimals with BigNumber; everything new of `packages/shared` exported from `src/index.ts`.
- **Aggregate reads (spec §2.3, §2.4):** every read of `token_lines` and `tokens` has `generation = {g:UInt32}`; it keeps the newest version of each key (`ORDER BY <key>, version DESC LIMIT 1 BY <key>`) and drops `deleted = 1` after that. A version is the runner's clock in milliseconds, at least one more than any version already written (Task 7's `nextVersion`), written as text (`UInt64`).
- **Definitions (spec §1), the one rule every test pins:** from the issuer's side of a line, the other account H **holds** the token when the balance is below 0 (H's balance is its negation); the line **counts** when H holds it, or the balance is 0 and H's limit (`limit_peer`) is above 0; holders are counting lines with H's balance above 0; supply is the exact sum of the holders' balances. LP currencies (`^03[0-9A-F]{38}$`) count for nothing.
- API answers: a key with no value is absent, never `null`; key orders are the `*_KEYS` constants of Task 9, pinned by tests and by `api-reference.spec.ts`; times `fmtTime` (`YYYY-MM-DDTHH:mm:ssZ`); amounts exact decimal text; counts and ranks numbers; `coverage` (`{ from_ledger_index?, complete }`, D3's) is the key right after `result` on every answer, never in a CSV. `Cache-Control` is the global default (`private, max-age=60`). Every route has the contract layer (`@RippleController`, `@RippleRoute`, `{result:"error", message}`, unknown parameters ignored).
- No node fallback anywhere in D6 (spec decision 11). No fetch of a toml: D6 reads D4's store only through D4's readers (spec §3.7). The api never reads `domain_tomls` or `account_domains` for tokens.
- **D9's seam (spec §8):** `kind` is accepted, echoed and part of the marker from the start; `TOKEN_KINDS = ['issued']`, the error text `invalid kind - use: ${TOKEN_KINDS.join(', ')}`; the controller dispatches the list to a `TokenListService` per kind through the `TOKEN_LIST_SERVICES` map. D9 adds `'mpt'` to `TOKEN_KINDS` and its service to the map and changes nothing else of this plan's code.
- The syncer's ClickHouse user needs `ALTER … DROP PARTITION` on `token_lines` and `tokens` (spec §10). Today it is the full-access `data_api` user (`docs/clickhouse.md`), so nothing changes in `deploy/`; the docs say it (Task 13).
- Metrics are syncer-only, prefix `syncer_`.

## Review Focus

1. **A line read the wrong way round.** Both limits above 0 at a zero balance (counts for both tokens), a line on which the "holder" owes (counts for the other side's token only), a line turned round by a payment, a frozen or unauthorized line, an AMM pool as holder, an LP line: each must land in exactly the right token's holders, trust lines and supply. Pinned by Task 3 `orientations: every sign and limit combination`, Task 4 `a fresh generation equals the brute force at the head`, Task 5 `turns a line round: a tombstone for one token, a row for the other`.
2. **Currency codes written another way.** `usd.r…`, the 40-hex of a text code (`524C555344…` RLUSD), the hex of a standard code (`…555344…` → `USD`), a text code holding `.` (split at the last separator), a code with a space, the native code with an issuer on each network (`XRP` on XRPL, `XAH` on Xahau, while Xahau's issued `XRP` is a token), and toml `[[CURRENCIES]]` codes in any of these forms. Pinned by Task 3 `currency-code.spec.ts` and `tokenListing matches every code form`, Task 9 `token-param.spec.ts`.
3. **Before the first generation and while coverage is incomplete.** The list answers the no-generation shape with `coverage`, the detail and holders 404, the transfers still list; a testnet profile answers `complete: false`; a token whose lines have not changed since the coverage start is a 404. Pinned by Task 10 `answers the no-generation shape before any live generation` and `testnet coverage is never complete`, Task 11 `404 token not found before any generation`.
4. **History rewritten under a live generation.** An older-parser ledger in a touch window starts a new generation while the live one keeps serving; a `--reprocess` reaches the job through `agg_dirty` and is repaired; a crash between the line writes and the token writes is repaired by the next run; a retired partition is dropped only after 15 minutes. Pinned by Task 7 `an older-parser ledger in a window starts a generation and the live one keeps serving`, `a crash between lines and tokens is repaired by the next run`, Task 8 `a reprocessed range is repaired through agg_dirty` and `a config bump builds, swaps and drops`.
5. **The issuer's toml says something else.** An entry for another issuer, an issuer D4 stored as `''` (an X-address), an entry whose `network` names another network, the entry in another domain's toml, a toml that failed beyond its grace, a domain change on the account, `display_decimals` out of 0–30: never listed, or listed only as D4's type rule allows; the sweep corrects a stale row. Pinned by Task 3 `tokenListing: two-way, this network, the issuer's own domain`, Task 6 `the sweep rewrites a row whose domain or toml changed and no other`.

---

### Task 1: Migration 014 and row types

**Files:**
- Create: `packages/shared/schema/014_issued_tokens.sql`
- Modify: `packages/shared/src/clickhouse/tables.ts`, `packages/shared/src/clickhouse/rows.ts`, `packages/shared/test/sample-rows.ts`, `packages/shared/test/migrate.e2e-spec.ts`, `docs/data-model.md` (§3 the four tables, the table count, §5 the migration row)

**Interfaces:**
- Consumes: nothing new (the migration runner and test harness of `packages/shared`).
- Produces: `Table.StateTouches = 'state_touches'` (in the ledger-table group), `Table.TokenGenerations = 'token_generations'`, `Table.TokenLines = 'token_lines'`, `Table.Tokens = 'tokens'` (a new group "Written by the aggregator's `tokens` job (migration 014)"); row types, fields in DDL order:
  ```ts
  export interface StateTouchesRow { ledger_index: number; tx_index: number; kind: 'line' | 'account'; account: string; counterparty: string; currency: string }
  export interface TokenGenerationsRow { generation: number; state: 'building' | 'live' | 'retired'; config_version: number; coverage_from: number;
    head_ledger: number; account_cursor: string; pass_done: number; through_ledger: number; repair_from: number; holders: number;
    holders_ledger: number; started_at: UnixSecondsMs; changed_at: UnixSecondsMs; version: UInt64Value }
  export interface TokenLinesRow { generation: number; issuer: string; currency: string; holder: string; balance: string; balance_f: number;
    limit: string; frozen: number; authorized: number; ledger_index: number; deleted: number; version: UInt64Value }
  export interface TokensRow { generation: number; issuer: string; currency: string; code: string; holders: number; trust_lines: number;
    supply: string; supply_f: number; last_ledger: number; issuer_ledger: number; issuer_flags: number; transfer_rate: number;
    domain: string; listed: number; name: string; toml: string; deleted: number; version: UInt64Value }
  ```

The four `CREATE TABLE IF NOT EXISTS` statements are spec §2.1–§2.4 verbatim (columns, engines, `PARTITION BY intDiv(ledger_index, 1000000)` and `SETTINGS non_replicated_deduplication_window = 1000` for `state_touches`, `PARTITION BY generation` for `token_lines` and `tokens`, no partition for `token_generations`). Header comment in the style of `006_trust_line_states.sql`: what each table holds, that `token_lines`/`tokens` are swapped and dropped by generation (the syncer drops partitions), and the runner constraints. `state_touches` joins `LEDGER_KEYED_TABLES` and `CHILD_TABLES` in Task 2, together, because a test keeps the two lists equal.

- [ ] **Step 1: Check the number, then write the failing tests.** `ls packages/shared/schema` must end at `013_*.sql`; otherwise use the next free number everywhere in this task. In `migrate.e2e-spec.ts`: `SHAPES` gains the four tables (engine `ReplacingMergeTree`, version column `''` for `state_touches` and `version` for the others, partition keys and sorting keys as the DDL); `SAMPLE_ROWS` gains a typed row per table (so "round-trips through the table" and "exactly the tables of the Table enum" cover them); new tests:
  - `it('applies 014 to a database migrated before it, and then nothing')` (the pattern of the 009 test).
  - `it('drops one generation of token_lines and tokens with DROP PARTITION')`: insert rows of generations 1 and 2 in both tables, `ALTER TABLE token_lines DROP PARTITION 1` and the same on `tokens`; `SELECT DISTINCT generation` gives `[2]` in each.
  - `it('keeps state_touches narrow and on a dedup window of 1000')`: `engine_full` contains `non_replicated_deduplication_window = 1000`; the columns are exactly the six of §2.1.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate` → FAIL: unknown tables, `Table` enum entries missing.
- [ ] **Step 3: Write the migration, the enum entries, the row types and `sample-rows.ts`;** update `docs/data-model.md`.
- [ ] **Step 4: Run them to verify they pass.** `pnpm --filter @gatehub/data-api-shared test` and `test:e2e` exit 0.
- [ ] **Step 5: Commit.** `git add packages/shared/schema/014_issued_tokens.sql packages/shared/src/clickhouse/tables.ts packages/shared/src/clickhouse/rows.ts packages/shared/test/sample-rows.ts packages/shared/test/migrate.e2e-spec.ts docs/data-model.md` — `feat(shared): migration 014 for the issued-token aggregate and its touch index` (body: the touch table is the ledger-ordered index the job scans, the aggregates are swapped by generation).

---

### Task 2: `StateTouchesParser`, the ledger rows and `TOKEN_PARSER_VERSION`

**Files:**
- Create: `packages/shared/src/parsers/state-touches.parser.ts`, `packages/shared/src/parsers/state-touches.parser.spec.ts`
- Modify: `packages/shared/src/ingest/build-rows.ts` (`LedgerRows.stateTouches`, `CHILD_TABLES`), `packages/shared/src/ingest/build-rows.spec.ts` (the `CHILD_TABLES` list and its title, the empty-ledger case), `packages/shared/src/ingest/__snapshots__/*` (updated, reviewed), `packages/shared/src/ingest/ingest-state.ts` (`LEDGER_KEYED_TABLES` gains `{ table: Table.StateTouches, partitionSize: P6 }`, its doc comment), `packages/shared/src/ingest/ingest-state.spec.ts`, `packages/shared/src/clickhouse/rows.ts` (`PARSER_VERSION`, `TOKEN_PARSER_VERSION`, the history comment), `packages/shared/src/index.ts`, `packages/shared/test/build-rows.e2e-spec.ts`, `packages/shared/test/fixtures/xrpl/account-state/` and new `packages/shared/test/fixtures/xahau/account-state/` (recorded ledgers, `manifest.json` `cases`), `packages/shared/test/fixtures/README.md`, `docs/backfill.md` (`TOKEN_PARSER_VERSION`: no re-ingest needed for the aggregate)

**Interfaces:**
- Consumes: Task 1 `Table.StateTouches`, `StateTouchesRow`; `ParserTx`, `ParseContext` (`parsers/parser.interface.ts`).
- Produces:
  ```ts
  export interface ParsedStateTouch { kind: 'line' | 'account'; account: string; counterparty: string; currency: string }
  export class StateTouchesParser { parse(t: ParserTx, ctx: ParseContext): ParsedStateTouch[] }
  export const TOKEN_PARSER_VERSION = 8;   // rows.ts; PARSER_VERSION = 8
  // LedgerRows gains `stateTouches: StateTouchesRow[]`; CHILD_TABLES gains [Table.StateTouches, 'stateTouches']
  ```

Rules (spec §4, and ruling R1): over `meta.AffectedNodes` in order, whatever the result,
- `line`: a `RippleState` `CreatedNode`, `DeletedNode`, or `ModifiedNode` with `PreviousFields` (one without changed nothing). `account` = `LowLimit.issuer`, `counterparty` = `HighLimit.issuer`, `currency` = `Balance.currency`, all of `NewFields` for a created node, else `FinalFields`. LP currencies are written too.
- `account` (`counterparty` and `currency` `''`): an `AccountRoot` `CreatedNode` or `DeletedNode`; a `ModifiedNode` with `PreviousFields` that holds `Flags`, `TransferRate` or `Domain`; **and** a `ModifiedNode` with `PreviousFields` of the sender of an `AccountSet` (a field set for the first time is not in `PreviousFields`, D4 §3.1, so a first `Domain` or `TransferRate` would be missed). A balance or sequence change of any other transaction makes no row.
- A node without the fields it needs is skipped. Pure: deep-frozen input, nothing shared with it.

`buildRows` pushes `{ ledger_index, tx_index, ...touch }` per transaction. `rows.ts` history: "8: the touch index of the token aggregate (`state_touches`). A ledger written by an older version has none; the job never applies a window that holds one (`TOKEN_PARSER_VERSION`)."

- [ ] **Step 1: Check the numbers, record the fixtures, write the failing tests.** `PARSER_VERSION` must be 7 and `OBJECT_PARSER_VERSION` exist; otherwise take the next number. Record (spec §12, outbound network needed; if unreachable, stop and report BLOCKED; never hand-write a recorded file): run `record:fixtures -- --network xrpl --endpoint wss://s2.ripple.com --out <scratch> --want AccountSet,Clawback,OfferCreate,AMMDeposit --scan 20000`, pick from the scratch ledgers the transactions of the cases below, and record those with `--txs` into `test/fixtures/xrpl/account-state/`, adding to its `cases`: `accountset_domain` (an `AccountSet` changing `Domain`), `accountset_transfer_rate`, `accountset_allow_clawback` (`SetFlag` 16), `clawback`, `payment_ripples_through_issuer`, `offercreate_two_issued_lines`, `ammdeposit_lp_line`; the same on Xahau (`wss://xahau.network`) into the new `test/fixtures/xahau/account-state/` with `trustset`, `payment_issued` (EVR) and `remit_issued`. The existing cases `trustset_preauthorizes` (tfSetfAuth), `trustline_deleted`, `trustset_freeze` are reused. A case not found within the scan is listed in the manifest's `missing` and in the README, and covered by a hand-built input below. Then:
  - `state-touches.parser.spec.ts`, hand-built transactions: `it('writes a line touch for a created, a modified and a deleted RippleState, from the final fields')`; `it('writes nothing for a RippleState modified without PreviousFields')`; `it('writes an account touch when Flags, TransferRate or Domain is among the PreviousFields')`; `it('writes an account touch for the sender of an AccountSet that sets Domain for the first time (only in FinalFields)')`; `it('writes no account touch for a Payment that changes only Balance and Sequence')`; `it('writes the touches of a failed transaction as its metadata says')`; `it('writes LP-currency lines too')`; `it('gives each (kind, account, counterparty, currency) once per transaction')`; `it('does not modify a deep-frozen transaction')`. On the recorded cases: `accountset_domain` and `accountset_transfer_rate` give one `account` touch for the sender; `clawback` gives the line and both roots' touches only where their `PreviousFields` say so; `remit_issued` (Xahau) gives its lines.
  - `build-rows.spec.ts`: `CHILD_TABLES` lists `Table.StateTouches` (title updated); an empty ledger has `stateTouches: []`; `ingest-state.spec.ts`: `state_touches` is partitioned by a million.
  - `build-rows.e2e-spec.ts` ("every table has rows" over the recorded ledgers) covers `state_touches`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- state-touches build-rows ingest-state` → FAIL.
- [ ] **Step 3: Implement** the parser, the wiring, the two lists, the version constants and the history line; run `pnpm --filter @gatehub/data-api-shared test -- -u build-rows` and check the snapshot diff holds only `stateTouches` arrays and `parser_version: 8`; update `docs/backfill.md` and the fixtures README (the new cases, endpoints, dates).
- [ ] **Step 4: Run them to verify they pass.** `pnpm --filter @gatehub/data-api-shared test` and `test:e2e` exit 0; `pnpm build` exits 0.
- [ ] **Step 5: Commit.** `git add packages/shared/src/parsers/state-touches.parser.ts packages/shared/src/parsers/state-touches.parser.spec.ts packages/shared/src/ingest packages/shared/src/clickhouse/rows.ts packages/shared/src/index.ts packages/shared/test/build-rows.e2e-spec.ts packages/shared/test/fixtures/xrpl/account-state packages/shared/test/fixtures/xahau/account-state packages/shared/test/fixtures/README.md docs/backfill.md` — `feat(shared): state_touches, the ledger-ordered touch index of the token aggregate (parser version 8)`.

---

### Task 3: Currency codes, line orientation and the toml listing (pure rules)

**Files:**
- Create: `packages/shared/src/util/currency-code.ts`, `packages/shared/src/util/currency-code.spec.ts`, `packages/shared/src/aggregate/token-rules.ts`, `packages/shared/src/aggregate/token-rules.spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: D4's `countsOn(entryNetwork, profile)`; `NetworkProfile.tomlNetworkNames`.
- Produces:
  ```ts
  // util/currency-code.ts
  export const LP_CURRENCY = /^03[0-9A-F]{38}$/;
  export function isLpCurrency(currency: string): boolean;
  /** The `code` of an answer: a 3-character currency as it is; 40 hex digits as the standard code they hold (bytes 12-14, the rest zero), else as their text when their bytes, trailing zeros dropped, are 1 to 20 printable ASCII (0x20-0x7E); else undefined. */
  export function currencyCode(currency: string): string | undefined;
  /** The ledger's form of a code a client or a toml writes: 3 characters of 0x21-0x7E upper-cased; 40 hex digits (any case) upper-cased, or the 3 characters of the standard form they hold, upper-cased; a text of 4 to 20 characters of 0x20-0x7E as its 40 hex digits, zero-padded, upper case; anything else (the all-zero hex included) undefined. */
  export function ledgerCurrencyOf(code: string): string | undefined;
  // aggregate/token-rules.ts
  export interface TokenKey { issuer: string; currency: string }
  /** A `trust_line_states` row, read from the low account's side (`account` low, `counterparty` high). */
  export interface LowSideLine { account: string; counterparty: string; currency: string; balance: string; limit: string; limit_peer: string;
    authorized: boolean; peer_authorized: boolean; freeze: boolean; peer_freeze: boolean; ledger_index: number; deleted: boolean }
  export interface WantedTokenLine { holder: string; balance: string; limit: string; frozen: 0 | 1; authorized: 0 | 1; ledger_index: number }
  /** Both orientations of a line: the token of the high account (holder: low, balance as stored, limit `limit`, issuer flags `peer_freeze`/`peer_authorized`) and of the low account (holder: high, balance negated, limit `limit_peer`, flags `freeze`/`authorized`); `wanted` is null when the line does not count for that token or is deleted. `[]` for an LP currency. */
  export function orientations(line: LowSideLine): Array<{ token: TokenKey; wanted: WantedTokenLine | null; holder: string }>;
  /** spec §1: H holds (issuer-side balance below 0), or the balance is 0 and H's limit is above 0. */
  export function countsFor(issuerSideBalance: string, holderLimit: string): boolean;
  /** Whether a stored `token_lines` row already says what `wanted` says (balance, limit, frozen, authorized, ledger_index). */
  export function sameTokenLine(stored: Pick<TokenLinesRow, 'balance' | 'limit' | 'frozen' | 'authorized' | 'ledger_index'>, wanted: WantedTokenLine): boolean;
  export interface StoredTomlCurrency { code: string; issuer: string; network: string; fields: string }  // a D4 `domain_tomls.currencies` entry
  export interface TokenListing { domain: string; listed: 0 | 1; name: string; toml: string }
  export const TOKEN_TOML_KEYS = ['name', 'desc', 'icon', 'symbol', 'display_decimals', 'asset_class', 'asset_subclass', 'attestation'] as const;
  /** spec §3.7: the first entry, in file order, that counts on this network (`countsOn`), names the token's issuer, and whose code is the token's currency in the ledger's form (`ledgerCurrencyOf`). */
  export function tokenListing(token: TokenKey, domain: string, currencies: readonly StoredTomlCurrency[] | undefined, profile: Pick<NetworkProfile, 'tomlNetworkNames'>): TokenListing;
  /** The served fields of an entry's `fields` JSON, in `TOKEN_TOML_KEYS` order: `display_decimals` a whole number 0 to 30, the others non-empty text; anything else (or JSON that is not an object) left out. */
  export function servedTomlFields(fields: string): Record<string, string | number>;
  ```
  `tokenListing` gives `{ domain, listed: 0, name: '', toml: '' }` without a match; with one, `name` is the entry's `name` text (else `''`) and `toml` is `JSON.stringify(servedTomlFields(entry.fields))`. An issuer stored as `''` never matches.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // currency-code.spec.ts
  expect(currencyCode('USD')).toBe('USD');
  expect(currencyCode('524C555344000000000000000000000000000000')).toBe('RLUSD');
  expect(currencyCode('0000000000000000000000005553440000000000')).toBe('USD');
  expect(currencyCode('4D5920544F4B454E000000000000000000000000')).toBe('MY TOKEN');
  expect(currencyCode('0158415500000000C1F76FF6ECB0BAC600000000')).toBeUndefined();
  expect([ledgerCurrencyOf('usd'), ledgerCurrencyOf('RLUSD'), ledgerCurrencyOf('524c555344000000000000000000000000000000'),
          ledgerCurrencyOf('0000000000000000000000005553440000000000'), ledgerCurrencyOf('a.b.c'), ledgerCurrencyOf('ab'),
          ledgerCurrencyOf('x'.repeat(21)), ledgerCurrencyOf('0'.repeat(40))])
    .toEqual(['USD', '524C555344000000000000000000000000000000', '524C555344000000000000000000000000000000', 'USD',
              'A.B.C', undefined, undefined, undefined]);
  expect([isLpCurrency('03A1F7' + '0'.repeat(34)), isLpCurrency('USD')]).toEqual([true, false]);
  ```
  `token-rules.spec.ts`:
  - `it.each(TABLE)('orientations: every sign and limit combination (%s)')` over: balance −5 (high holds low's token? no — from the low side −5 means low owes high: the low account's token, holder high, balance 5); +5 (the high account's token, holder low, balance 5); 0 with both limits above 0 (both tokens counted, balance 0); 0 with only `limit_peer` above 0 (only the low account's token); 0 with no limits (neither); a deleted line (both `wanted` null); an LP currency (`[]`). Each case asserts `token`, `holder`, `wanted.balance`, `wanted.limit` and that `frozen`/`authorized` come from the issuer's side (`freeze`/`authorized` for the low account's token, `peer_*` for the high's).
  - `it('countsFor: holds, or zero with a limit above 0')`: `countsFor('-1', '0')` true, `countsFor('0', '1')` true, `countsFor('0', '0')` false, `countsFor('1', '1000')` false.
  - `it('tokenListing matches every code form')`: entries with `code` `usd`, `RLUSD`, its hex in lower case, the hex of `USD`, each matching the token in the ledger form; `it('tokenListing: two-way, this network, the issuer\'s own domain')`: another issuer → not listed; issuer `''` → not; `network: 'testnet'` on the XRPL profile → not, `''` and `'mainnet'` → yes, Xahau's `'21337'` → yes on Xahau; the first matching entry wins; no currencies (a failed toml) → not listed with the domain kept.
  - `it('servedTomlFields keeps the served keys in order and D4\'s types')`: `{"desc":"d","name":"N","display_decimals":2,"extra":"x","icon":7,"asset_class":""}` → `{ name: 'N', desc: 'd', display_decimals: 2 }`; `display_decimals` 31, 2.5 or `"2"` dropped; invalid JSON → `{}`.
  - `it('sameTokenLine compares the five fields')`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- currency-code token-rules` → FAIL: modules not found.
- [ ] **Step 3: Implement** the two modules (exact text for the negation: `BigNumber(...).negated().toFixed()`, `'0'` stays `'0'`).
- [ ] **Step 4: Run them to verify they pass.** Same command → PASS; `pnpm --filter @gatehub/data-api-shared build` exits 0.
- [ ] **Step 5: Commit.** `git add packages/shared/src/util/currency-code.ts packages/shared/src/util/currency-code.spec.ts packages/shared/src/aggregate/token-rules.ts packages/shared/src/aggregate/token-rules.spec.ts packages/shared/src/index.ts` — `feat(shared): the rules of an issued token: codes, orientation and the toml listing`.

---

### Task 4: Generations, the account pass and the token rows

**Files:**
- Create: `packages/shared/src/aggregate/tokens.job.ts`, `packages/shared/test/tokens-world.ts`, `packages/shared/test/tokens-job.e2e-spec.ts`
- Modify: `packages/shared/src/query/decimal.ts` (`exactAmount`'s column union gains `'balance'`, the `token_lines` column with its `balance_f` shadow), `packages/shared/src/query/decimal.spec.ts`, `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: Task 1 tables and rows; Task 3 `TokenKey`, `tokenListing`, `currencyCode`, `LP_CURRENCY`; `exactAmount`, `exactSum`, `sumOf` (`query/decimal.ts`); D3's `newestLedgerBelowVersion(ch, version)`; D4's `accountDomainOf(hex: string): string | undefined` and `readStoredTomls(ch, domains: readonly string[]): Promise<Map<string, DomainTomlsRow>>` (the newest `domain_tomls` row of each domain; this plan reads only its `currencies`, whose entries are Task 3's `StoredTomlCurrency`), `Table.AccountDomains`; `STATE_PARSER_VERSION`.
- Produces (`tokens.job.ts`):
  ```ts
  export const TOKENS_CONFIG_VERSION = 1;
  export const TOKENS_PASS_ACCOUNTS = 500;
  export const TOKENS_TOUCH_WINDOW = 500;            // ledgers
  export const TOKENS_TOUCH_WINDOW_MAX_LINES = 20_000;
  export const TOKENS_STATE_CHUNK = 2_000;            // keys per read (query parameters travel in the URL: ADR-0012)
  export const TOKENS_TOML_DOMAINS_CHUNK = 2_000;
  export const TOKENS_HOUSEKEEPING_EVERY_TICKS = 10;
  export const TOKENS_RETIRED_KEEP_MS = 15 * 60_000;
  export const TOKENS_PROMOTE_NEAR_HEAD = 10;         // ledgers, when there is no live generation
  export function readTokenGenerations(ch: ClickHouseService): Promise<TokenGenerationsRow[]>;   // newest row per generation, ascending; version as text
  export function liveGenerationOf(gens: readonly TokenGenerationsRow[]): TokenGenerationsRow | undefined;      // the highest whose state is live
  export function buildingGenerationOf(gens: readonly TokenGenerationsRow[]): TokenGenerationsRow | undefined;  // the highest whose state is building
  export function writeTokenGeneration(ch: ClickHouseService, row: TokenGenerationsRow, signal?: AbortSignal): Promise<void>;
  /** One more than `newestLedgerBelowVersion(ch, STATE_PARSER_VERSION)`, else the oldest stored ledger, else undefined (no ledger). */
  export function stateCoverageStart(ch: ClickHouseService): Promise<number | undefined>;
  /** The highest version written to token_generations or to the tokens rows of the generations that are not retired, as text ('0' when none). */
  export function tokensVersionFloor(ch: ClickHouseService): Promise<string>;
  export function nextPassAccounts(ch: ClickHouseService, after: string, n: number): Promise<string[]>;
  export function writePassLines(ch: ClickHouseService, p: { generation: number; after: string; through: string; head: number; version: string }, signal?: AbortSignal): Promise<void>;
  export function passTokens(ch: ClickHouseService, p: { generation: number; after: string; through: string }): Promise<TokenKey[]>;
  /** The account domain of each issuer (D4's `accountDomainOf` of its current `account_domains` row), '' when none. */
  export function issuerDomains(ch: ClickHouseService, issuers: readonly string[]): Promise<Map<string, string>>;
  /** Writes the `tokens` row of each token at `atLedger`: counts and supply from the newest live lines, the issuer's settings from its newest
   *  `account_states` row at or before `atLedger`, the listing matched afresh for the issuers in `rematch` (or all) and kept from the newest
   *  row otherwise (a token without one is matched); a token with no live line gets a deleted row when it had a live one. */
  export function recomputeTokens(ch: ClickHouseService, p: { generation: number; tokens: readonly TokenKey[]; atLedger: number; version: string;
    profile: NetworkProfile; rematch: 'all' | ReadonlySet<string> }, signal?: AbortSignal): Promise<void>;
  ```
  `test/tokens-world.ts` (test support, exported for the syncer and api suites by relative path): `seedTokensWorld(ch, writer, o?)` writes synthetic ledgers through `LedgerWriter` whose transactions carry hand-built `RippleState` and `AccountRoot` nodes (a few issuers, a few dozen holders, every case of Task 3's table, an issuer with `TransferRate` and `GlobalFreeze`, an AMM pool account as a holder, an LP line), plus `account_domains` and `domain_tomls` rows written directly; and `bruteForceTokens(ch, head): Promise<Map<string, { holders: number; trust_lines: number; supply: string }>>` (the oracle: `trust_line_states` at `head`, both sides, §1 applied in TypeScript with Task 3's `orientations`).

**The pass's line insert** (the shape matters: a key range, the newest row per line, the issuer's side only):
```sql
INSERT INTO token_lines (generation, issuer, currency, holder, balance, balance_f, `limit`, frozen, authorized, ledger_index, deleted, version)
SELECT {g:UInt32}, account, currency, counterparty,
       if(startsWith(balance, '-'), substring(balance, 2), '0') AS holder_balance, toFloat64(holder_balance),
       limit_peer, freeze, authorized, ledger_index, 0, {version:UInt64}
  FROM (SELECT account, counterparty, currency, ledger_index, balance, limit_peer, freeze, authorized, deleted
          FROM trust_line_states
         WHERE account > {after:String} AND account <= {through:String} AND ledger_index <= {head:UInt32}
         ORDER BY account, counterparty, currency, ledger_index DESC, tx_index DESC, node_index DESC
         LIMIT 1 BY account, counterparty, currency)
 WHERE deleted = 0 AND NOT match(currency, '^03[0-9A-F]{38}$')
   AND (startsWith(balance, '-') OR (balance = '0' AND limit_peer != '0'))
```
**The token rows' grouped read** (keys as two arrays zipped, as `paymentsByKeys` does, `TOKENS_STATE_CHUNK` tokens a read): over the newest row per `(issuer, currency, holder)` of the generation inside, `deleted = 0` outside, `GROUP BY issuer, currency`: `countIf(balance_f > 0)` holders, `count()` trust lines, `exactSum` of `exactAmount('balance')` with its unfit count and `sumKahan(balance_f)` read back by `sumOf` (`supply` = its `.toFixed()`), `max(ledger_index)`. Issuers' settings: `account_states` by `account IN {issuers}` and `ledger_index <= {at}`, newest per account (`LIMIT 1 BY account`): `flags`, `JSONExtractUInt(fields, 'TransferRate')`, `ledger_index` (`issuer_ledger` 0 when none or deleted). Domains: `SELECT account, argMax(domain_hex, version), argMax(deleted, version) FROM account_domains WHERE account IN {issuers} GROUP BY account`, through `accountDomainOf`. Tomls: `readStoredTomls` of the distinct non-empty domains, `TOKENS_TOML_DOMAINS_CHUNK` at a time. `code` = `currencyCode(currency) ?? ''`.

- [ ] **Step 1: Write the failing tests.** `decimal.spec.ts`: `exactAmount('balance')` reads `balance_f` for its limit. `tokens-job.e2e-spec.ts` (one container, the world seeded once):
  - `it('a fresh generation equals the brute force at the head')`: `nextPassAccounts`/`writePassLines`/`passTokens`/`recomputeTokens` in batches of 3 accounts until done; for every token of `bruteForceTokens(ch, head)`, the newest live `tokens` row has the same `holders`, `trust_lines` and `supply` (exact text), and no other token has a live row.
  - `it('counts a zero line with both limits above 0 for both tokens, and no LP line')`.
  - `it('takes the issuer settings from its newest account_states row at the head, and 0 without one')`: `issuer_flags`, `transfer_rate` 1002000000, `issuer_ledger`.
  - `it('lists a token only from its issuer\'s own domain\'s toml')` (the world's second domain lists the token too: ignored), with `name` and `toml` as Task 3 gives them.
  - `it('nextPassAccounts walks the accounts in key order and stops after n')`.
  - `it('the pass reads a key range of trust_line_states')`: `EXPLAIN indexes = 1` of the insert's SELECT shows the primary key condition on `account`.
  - `it('stateCoverageStart is one more than the newest ledger of an older parser, else the oldest ledger')`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test:e2e -- tokens-job` → FAIL: module not found.
- [ ] **Step 3: Implement** `tokens.job.ts` (this task's functions), the world and the oracle.
- [ ] **Step 4: Run them to verify they pass.** `pnpm --filter @gatehub/data-api-shared test` and `test:e2e -- tokens-job migrate` exit 0.
- [ ] **Step 5: Commit.** `git add packages/shared/src/aggregate/tokens.job.ts packages/shared/src/query/decimal.ts packages/shared/src/query/decimal.spec.ts packages/shared/src/index.ts packages/shared/test/tokens-world.ts packages/shared/test/tokens-job.e2e-spec.ts` — `feat(shared): token generations, the account pass and the token rows`.

---

### Task 5: Applying touches

**Files:**
- Modify: `packages/shared/src/aggregate/tokens.job.ts`, `packages/shared/test/tokens-job.e2e-spec.ts`, `packages/shared/test/tokens-world.ts` (a second batch of ledgers after the first head)

**Interfaces:**
- Consumes: Task 3 `orientations`, `sameTokenLine`; Task 4 `recomputeTokens`, constants; `TOKEN_PARSER_VERSION`.
- Produces:
  ```ts
  export interface LineKey { account: string; counterparty: string; currency: string }   // low, high, the ledger's currency
  /** The lowest parser version of the ledgers in (from, to], null when the window has no ledger. */
  export function parserFloorOf(ch: ClickHouseService, from: number, to: number): Promise<number | null>;
  /** The window (from, to] the job applies next, to = min(from + window, head), halved while it holds more than `maxLines` distinct lines (never below one ledger), with its distinct line touches (LP currencies dropped) and the issuers of its account touches. */
  export function touchesOfWindow(ch: ClickHouseService, from: number, head: number, o?: { window?: number; maxLines?: number }):
    Promise<{ to: number; lines: LineKey[]; issuers: string[] }>;
  /** Reads the newest low-side row of each line at or before `atLedger` (TOKENS_STATE_CHUNK lines a read) and writes, for both orientations, the wanted `token_lines` row where it differs from the newest stored one, or a tombstone where a live row no longer counts. Returns every token of the lines, both orientations, changed or not. */
  export function applyLineStates(ch: ClickHouseService, p: { generation: number; lines: readonly LineKey[]; atLedger: number; version: string }, signal?: AbortSignal): Promise<TokenKey[]>;
  /** The tokens of the issuers in the generation (each issuer's prefix of `tokens`, newest rows, deleted ones included). */
  export function tokensOfIssuers(ch: ClickHouseService, generation: number, issuers: readonly string[]): Promise<TokenKey[]>;
  ```
  The line read: `SELECT … FROM trust_line_states WHERE (account, counterparty, currency) IN (<the zipped keys>) AND ledger_index <= {at} ORDER BY account, counterparty, currency, ledger_index DESC, tx_index DESC, node_index DESC LIMIT 1 BY account, counterparty, currency` (only the low side: `account < counterparty` holds for every key the parser wrote). The stored rows to compare: `token_lines` of the generation by `(issuer, currency, holder) IN (…)`, newest per key. A line with no state row at or before `atLedger` (removed by a re-ingest) is treated as deleted.

- [ ] **Step 1: Write the failing tests** (`tokens-job.e2e-spec.ts`, after Task 4's describe):
  - `it('an incremental generation equals a fresh one built at the same head, row for row')`: generation 1 by the pass at head H1, then `touchesOfWindow` / `applyLineStates` / `recomputeTokens` (rematch: the window's issuers) window by window to H2; generation 2 by the pass at H2; the newest live rows of `token_lines` (issuer, currency, holder, balance, limit, frozen, authorized) and of `tokens` (every column but `generation` and `version`) are equal.
  - `it('turns a line round: a tombstone for one token, a row for the other')` and `it('writes a tombstone for a deleted line and for one emptied with no limit')`.
  - `it('applying a window twice changes nothing')`: the newest rows before and after equal; no new version for an unchanged key.
  - `it('an account touch recomputes the issuer\'s tokens with its new TransferRate and domain')`.
  - `it('halves a window that holds more than maxLines lines')`: `touchesOfWindow(ch, H1, H2, { window: 500, maxLines: 3 })` returns a `to` below H2 and at most 3 lines unless the window is one ledger.
  - `it('parserFloorOf gives the lowest version of the window')` (one ledger rewritten with `parser_version` 7).
  - `it('reads a key range of state_touches and key prefixes of trust_line_states')`: `EXPLAIN indexes = 1` of both reads shows their primary key conditions.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test:e2e -- tokens-job` → FAIL.
- [ ] **Step 3: Implement** the four functions.
- [ ] **Step 4: Run them to verify they pass.** Same command → PASS; `pnpm --filter @gatehub/data-api-shared test` exits 0.
- [ ] **Step 5: Commit.** `git add packages/shared/src/aggregate/tokens.job.ts packages/shared/test/tokens-job.e2e-spec.ts packages/shared/test/tokens-world.ts` — `feat(shared): apply state touches to a token generation`.

---

### Task 6: Distinct holders, the toml sweep and dropping a generation

**Files:**
- Modify: `packages/shared/src/aggregate/tokens.job.ts`, `packages/shared/test/tokens-job.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 3 `tokenListing`; Task 4 `issuerDomains`, the toml read.
- Produces:
  ```ts
  /** uniqExact(holder) over the generation's newest live lines with balance_f > 0. */
  export function distinctHolders(ch: ClickHouseService, generation: number): Promise<number>;
  /** spec §3.7: every live token's (domain, listed, name, toml) against the issuers' current account domains and D4's store; rewrites (the same counts, a new version) the rows that differ. Returns how many. */
  export function tomlSweep(ch: ClickHouseService, p: { generation: number; version: string; profile: NetworkProfile }, signal?: AbortSignal): Promise<number>;
  /** `ALTER TABLE … DROP PARTITION {generation}` on token_lines and tokens (the number checked as a UInt32 and inlined). */
  export function dropTokenGeneration(ch: ClickHouseService, generation: number): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests:** `it('distinctHolders counts an account holding two tokens once and a zero line not at all')`; `it('the sweep rewrites a row whose domain or toml changed and no other')` (change one issuer's `account_domains` row and another domain's `domain_tomls` row; the sweep returns 2; the other rows keep their version); `it('the sweep un-lists a token whose toml failed beyond its grace')` (a newer `domain_tomls` row with empty content); `it('dropTokenGeneration drops only that generation of both tables')`; `it('refuses a generation that is not a UInt32')` (`-1`, `1.5` throw before any query).
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test:e2e -- tokens-job` → FAIL.
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run them to verify they pass.** Same command → PASS.
- [ ] **Step 5: Commit.** `git add packages/shared/src/aggregate/tokens.job.ts packages/shared/test/tokens-job.e2e-spec.ts` — `feat(shared): distinct token holders, the toml sweep and dropping a token generation`.

---

### Task 7: `TokensJobRunner`

**Files:**
- Create: `apps/syncer/src/aggregator/tokens.job-runner.ts`, `apps/syncer/src/aggregator/tokens.job-runner.spec.ts`
- Modify: `apps/syncer/src/aggregator/job-context.ts` (`AggregatorJobName` gains `'tokens'`), `apps/syncer/src/modules/prometheus/prometheus.service.ts` (+ spec)

**Interfaces:**
- Consumes: `AggregatorJobContext`, `AggregatorTick`, `describe` (`job-context.ts`); Tasks 4–6 functions and constants; `committedCheckpoint` (the head); `RatesService.ledgersClosedIn(from, toExclusive)`; `NetworkProfile`.
- Produces:
  ```ts
  export interface AggregatorTokens {
    profile: NetworkProfile;
    rates: RatesService;                 // the slice of an agg_dirty range → its ledgers
    configVersion?: number;              // default TOKENS_CONFIG_VERSION (tests bump it)
    retiredKeepMs?: number;              // default TOKENS_RETIRED_KEEP_MS (tests use 0)
  }
  export interface TokensFunctions { readTokenGenerations; writeTokenGeneration; stateCoverageStart; tokensVersionFloor; committedHead;
    nextPassAccounts; writePassLines; passTokens; parserFloorOf; touchesOfWindow; applyLineStates; tokensOfIssuers; recomputeTokens;
    distinctHolders; tomlSweep; dropTokenGeneration }   // each `typeof` its shared function; committedHead = committedCheckpoint
  export const TOKENS_FUNCTIONS: TokensFunctions;
  export class TokensJobRunner {
    constructor(ctx: AggregatorJobContext, tokens: AggregatorTokens, fns: TokensFunctions);
    run(tick: AggregatorTick): Promise<void>;
    /** The agg_dirty hook: sets repair_from of every generation whose through_ledger reaches the slice; no other work. */
    ofSlice(start: number, end: number, tick: AggregatorTick): Promise<void>;
  }
  // PrometheusService gains: tokensLive (syncer_tokens_live, Gauge), tokensLagLedgers (syncer_tokens_lag_ledgers, Gauge),
  //   tokensBuilding (syncer_tokens_building, Gauge), tokensRepairLedgers (syncer_tokens_repair_ledgers, Gauge); help texts from spec §3.8
  ```

**A run** (spec §3), each step only while `ctx.mayStartSet(tick, 'tokens')` and not closing; every write moves a cursor only after its rows are written; a failure is `ctx.failed('tokens', err)` and the next tick starts over from the stored generation rows:
1. Read the generations (`readTokenGenerations`) and the head; on the first run, `versionFloor = tokensVersionFloor`. `nextVersion()` = `max(ctx.clock(), floor + 1)` as text, and the floor moves to it.
2. **Live touches** (`through_ledger` T < head): `touchesOfWindow(T, head)`; `parserFloorOf(T, to) < TOKEN_PARSER_VERSION` → mark that a rebuild is needed and stop applying (the live one keeps serving); else `applyLineStates` + `tokensOfIssuers(issuers)` + `recomputeTokens` (rematch: the window's issuers) at `to`, then a generation row with `through_ledger = to`. Loop while budget.
3. **Repair** (live `repair_from` > 0): the same windows over `[repair_from, through_ledger]`, each followed by a generation row with `repair_from` = the window's `to + 1`, or 0 once past `through_ledger`; `through_ledger` does not move.
4. Every `TOKENS_HOUSEKEEPING_EVERY_TICKS`-th run (counted here, the first run included): the **rebuild check** (start a generation when there is no live and no building one, when the live `config_version` ≠ `configVersion`, when `stateCoverageStart` ≠ its `coverage_from`, or when step 2 found an older-parser window; a building generation that is stale for the same reasons is written `retired` first); `distinctHolders` → a live row with `holders`, `holders_ledger = through_ledger`; `tomlSweep`.
5. **Building** generation: its pass (`nextPassAccounts` from `account_cursor`, `TOKENS_PASS_ACCOUNTS` a batch, `writePassLines`, `passTokens`, `recomputeTokens` (rematch `'all'`) at `head_ledger`, a row with the new cursor; `pass_done = 1` when the list is empty), then its touches from `through_ledger` (= `head_ledger` at start) as step 2, then **promotion** once `pass_done` and `through_ledger` ≥ the live one's (or ≥ head − `TOKENS_PROMOTE_NEAR_HEAD` with no live one): a `live` row for it, then a `retired` row for the old one.
6. **Drop** every retired generation whose `changed_at` is more than `retiredKeepMs` ago and whose partitions are still there (once: remembered in memory, and harmless again after a restart).
7. Metrics: `tokensLive` 1/0, `tokensLagLedgers` head − live `through_ledger`, `tokensBuilding` 1/0, `tokensRepairLedgers` live `through_ledger − repair_from` (0 without). The building pass logs its cursor at each batch.

A new generation row: `generation` = highest + 1, `state` building, `config_version`, `coverage_from` = `stateCoverageStart`, `head_ledger` = head, `account_cursor` '', `pass_done` 0, `through_ledger` = head, `repair_from` 0, `holders` 0, `started_at` = `changed_at` = now. No generation is started without a ledger.

**The hook:** `rates.ledgersClosedIn(start, end)` → `{min, max}` or none; for each live or building generation with `through_ledger >= min` and `max >= coverage_from`: `repair_from = repair_from === 0 ? max(min, coverage_from) : min(repair_from, max(min, coverage_from))`, one generation row. It reads and writes nothing else.

- [ ] **Step 1: Write the failing tests** (`tokens.job-runner.spec.ts`, fakes of `TokensFunctions` over an in-memory generation table, `fakeDeps`-style context, the clock under the test's control):
  - `it('runs live touches, repair, housekeeping, the building generation and the drop, in that order')`;
  - `it('stops at the budget and goes on next tick from the stored cursors')`;
  - `it('walks the pass in batches and moves account_cursor only after the batch is written')` (a write that throws leaves the cursor; the next run redoes the batch);
  - `it('moves through_ledger only after the lines and the tokens of the window are written')`;
  - `it('a crash between lines and tokens is repaired by the next run')` (recompute throws once: the next run applies the same window again);
  - `it('an older-parser ledger in a window starts a generation and the live one keeps serving')`;
  - `it('promotes a building generation once its pass is done and it has caught up, then retires the old one')` and `it('without a live generation, promotes within 10 ledgers of the head')`;
  - `it('retires a stale building generation before starting another')` (config bump while building);
  - `it('drops a retired generation 15 minutes after it was retired, not before')`;
  - `it('runs housekeeping on the 1st, 11th, 21st run')`;
  - `it('the hook sets repair_from to the slice\'s first ledger and does nothing else')` and `it('the hook leaves a slice below coverage_from to the rebuild check')`;
  - `it('gives versions that never go back, above the stored floor')`;
  - `it('sets the four gauges')`; `prometheus.service.spec.ts`: the four metrics are registered with their names.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- tokens.job-runner prometheus` → FAIL.
- [ ] **Step 3: Implement** the runner, `AggregatorJobName`'s `'tokens'` and the four gauges.
- [ ] **Step 4: Run them to verify they pass.** Same command → PASS; `pnpm build` exits 0.
- [ ] **Step 5: Commit.** `git add apps/syncer/src/aggregator/tokens.job-runner.ts apps/syncer/src/aggregator/tokens.job-runner.spec.ts apps/syncer/src/aggregator/job-context.ts apps/syncer/src/modules/prometheus/prometheus.service.ts apps/syncer/src/modules/prometheus/prometheus.service.spec.ts` — `feat(syncer): the tokens job runner: generations built, kept current, repaired and swapped`.

---

### Task 8: The `tokens` job in the aggregator, end to end

**Files:**
- Modify: `apps/syncer/src/aggregator/aggregator.service.ts` (`AGGREGATOR_TOKENS_BUDGET_MS = 4000`, `budgets.tokens`, `AggregatorOptions.tokens?: AggregatorTokens` and `tokensFunctions?: Partial<TokensFunctions>`, the job after `markets_live` and before `stats_live`, the hook in `recomputeDirty` after `amm_pools`' with failures counted as `tokens_dirty`, the class comment's job list), `apps/syncer/src/aggregator/aggregator.module.ts` (`aggregatorOptions` sets `tokens: { profile, rates }` and logs "Tokens job on"), `apps/syncer/src/aggregator/aggregator.service.spec.ts`, `apps/syncer/src/aggregator/aggregator.schedule.spec.ts`, `apps/syncer/src/aggregator/aggregator.module.spec.ts`
- Create: `apps/syncer/test/tokens.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 7 `TokensJobRunner`, `AggregatorTokens`, `TOKENS_FUNCTIONS`; `packages/shared/test/tokens-world.ts` (`seedTokensWorld`, `bruteForceTokens`), the syncer's e2e support (`aggregates-e2e-support.ts`).
- Produces: the job `tokens` in every aggregator built by `aggregatorOptions` (on by default); `AggregatorOptions.tokens` for tests.

- [ ] **Step 1: Write the failing tests.**
  - `aggregator.service.spec.ts`: `it('runs tokens after markets_live and before stats_live, with its own budget')`; `it('counts a failure of the tokens hook as tokens_dirty and fails the slice')`; `aggregator.module.spec.ts`: `it('turns the tokens job on with the profile and the rates')`; `aggregator.schedule.spec.ts`: `it('does not starve the live sets with tokens registered')`.
  - `tokens.e2e-spec.ts` (testcontainers, the world written by `LedgerWriter`, a real `AggregatorService` ticked by hand):
    - `it('builds the first generation and makes it live; every token equals the brute force at its through_ledger')`;
    - `it('keeps the live generation current as ledgers arrive, equal to a fresh build at the same head')` (a second service with `configVersion: 2` builds fresh at the same head; rows compared as in Task 5);
    - `it('a reprocessed range is repaired through agg_dirty')` (rewrite a range with changed lines through the range-ingest path that marks `agg_dirty`; after the dirty tick and the repair, equal to the brute force);
    - `it('a config bump builds, swaps and drops')` (`configVersion: 2`, `retiredKeepMs: 0`: generation 2 live, generation 1 `retired`, its partitions gone from `system.parts`);
    - `it('leaves LP lines out')`; `it('syncer_tokens_live is 1 and the lag 0 once caught up')`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- aggregator` and `pnpm --filter @gatehub/data-syncer test:e2e -- tokens` → FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run them to verify they pass.** Same commands → PASS; `pnpm --filter @gatehub/data-syncer test:e2e` exits 0.
- [ ] **Step 5: Commit.** `git add apps/syncer/src/aggregator apps/syncer/test/tokens.e2e-spec.ts` — `feat(syncer): the tokens job in the aggregator, after markets_live, with its agg_dirty hook`.

---

### Task 9: API pure parts: the path, the list query, the objects and the price turning

**Files:**
- Create: `apps/api/src/tokens/token-param.ts`, `token-list.ts`, `token-objects.ts`, `token-markets.ts` (its pure functions only here), each with a `*.spec.ts`

**Interfaces:**
- Consumes: Task 3 `currencyCode`, `ledgerCurrencyOf`, `isLpCurrency`, `TOKEN_TOML_KEYS`; `badRequest`, `notFound` (`common/errors.ts`); `encodeMarker`, `decodeMarker`, `KeysetKey` (`common/pagination.ts`); `first`, `limitParam`, `Query` (`common/params.ts`); `fmtTime`, `precision8`, `changePercent` (`common/format.ts`); `ratio` (shared `decimal.ts`); `accountFlagsOf`, `namedAccountFlags`; `StoredMarket` (`network/markets-object.ts`); `PaymentObject`; D3's `Coverage` type.
- Produces:
  ```ts
  // token-param.ts
  export interface TokenRef { currency: string; issuer: string }                       // the ledger's currency
  /** spec §5.2: split at the last '.', '+' or '|'; errors in order: 400 `invalid currency`, `${native} cannot have an issuer`, `invalid issuer address` (no separator: the issuer is '' → invalid issuer address). */
  export function parseTokenParam(raw: string, native: 'XRP' | 'XAH'): TokenRef;
  /** `<code or currency> <issuer>`, the stem of the CSV names. */
  export function tokenFileStem(t: TokenRef): string;
  // token-list.ts — the list of every kind (D9 extends TOKEN_KINDS and TOKEN_LIST_SERVICES)
  export const TOKEN_KINDS = ['issued'] as const;
  export type TokenKind = (typeof TOKEN_KINDS)[number];
  export interface TokenListQuery { kind: TokenKind; minHolders: number; q?: string; limit: number; marker?: string; csv: boolean }
  /** Checks, in order: kind (400 `invalid kind - use: ${TOKEN_KINDS.join(', ')}`), min_holders (plain digits 0..1e9, else `invalid min_holders`), q (trimmed, 1..64, else `invalid search`; empty is none), limit (200, max 1000). */
  export function parseTokenListQuery(query: Query): TokenListQuery;
  export function encodeTokenListMarker(kind: TokenKind, holders: number, issuer: string, key: string): string;
  /** [holders, issuer, key] or undefined; 400 `invalid marker` for anything else, a marker of another kind included. */
  export function decodeTokenListMarker(marker: string | undefined, kind: TokenKind): [number, string, string] | undefined;
  export interface TokenListPage<Row, Totals> { ledgerIndex: number; closeTime: number; totals: Totals; total: number; totalBelow?: number; rows: Row[]; marker?: string }
  export interface TokenListService<Row = unknown, Totals = unknown> {
    readonly kind: TokenKind;
    coverage(): Promise<Coverage>;       // the answer's coverage (issued: D3's FeatureCoverageService.coverage('issued_tokens'), Task 10)
    list(q: TokenListQuery): Promise<TokenListPage<Row, Totals> | undefined>;   // undefined: no data yet (the no-generation answer)
  }
  export const TOKEN_LIST_SERVICES = Symbol('TOKEN_LIST_SERVICES');                  // provides ReadonlyMap<TokenKind, TokenListService>
  export const TOKEN_LIST_KEYS = ['result', 'coverage', 'kind', 'ledger_index', 'close_time', 'totals', 'total', 'total_below', 'count', 'marker', 'tokens'];
  /** The envelope of spec §5.1/§8 for any kind; the no-generation answer `{result, coverage, kind, count: 0, tokens: []}` for `undefined`. */
  export function tokenListBody(kind: TokenKind, coverage: Coverage, page: TokenListPage<unknown, unknown> | undefined): Record<string, unknown>;
  // token-objects.ts
  export const ISSUED_TOTALS_KEYS = ['tokens', 'tokens_with_10_holders', 'holders', 'native_volume'];
  export const ISSUED_TOKEN_ROW_KEYS = ['rank', 'currency', 'code', 'issuer', 'holders', 'trust_lines', 'supply', 'price', 'price_change',
    'price_time', 'native_volume', 'trades', 'domain', 'listed', 'name'];
  export const TOKEN_ANSWER_KEYS = ['result', 'coverage', 'ledger_index', 'close_time', 'token'];
  export const TOKEN_KEYS = ['currency', 'code', 'issuer', 'holders', 'trust_lines', 'supply', 'price', 'price_change', 'price_time',
    'native_volume', 'trades', 'domain', 'toml_url', 'listed', 'toml', 'issuer_settings', 'markets', 'last_ledger'];
  export const ISSUER_SETTINGS_KEYS = ['transfer_fee', 'global_freeze', 'no_freeze', 'allow_trust_line_clawback', 'require_auth', 'default_ripple'];
  export const TOKEN_MARKET_KEYS = ['counter_currency', 'counter_issuer', 'count', 'volume', 'counter_volume', 'native_volume', 'last', 'change', 'last_time', 'amm_pool'];
  export const HOLDERS_ANSWER_KEYS = ['result', 'coverage', 'ledger_index', 'close_time', 'supply', 'count', 'marker', 'holders'];
  export const HOLDER_ROW_KEYS = ['rank', 'holder', 'balance', 'share', 'limit', 'frozen', 'authorized'];
  export const TRANSFERS_ANSWER_KEYS = ['result', 'coverage', 'count', 'marker', 'transfers'];
  export const TRANSFER_ROW_KEYS = ['hash', 'ledger_index', 'executed_time', 'source', 'destination', 'amount', 'source_tag', 'destination_tag'];
  export interface StoredToken { issuer; currency; code; holders: number; trust_lines: number; supply: string; last_ledger: number; issuer_ledger: number;
    issuer_flags: number; transfer_rate: number; domain: string; listed: number; name: string; toml: string }
  export function issuedTokenRow(t: StoredToken & { rank: number }, m: TokenMarketFacts): IssuedTokenRow;
  export function tokenObject(t: StoredToken, m: TokenMarketFacts, markets: TokenMarket[], profile: NetworkProfile): TokenObject;
  export function issuerSettingsOf(flags: number, transferRate: number, profile: NetworkProfile): IssuerSettings;   // flags by name (accountFlagsOf)
  export function transferFeeOf(rate: number): string;            // (rate − 1e9) / 1e7 exact; 0 and 1e9 → "0"
  export function shareOf(balance: string, supply: string): string;   // 6 decimals, half up; supply 0 → "0.000000"
  export function holderRow(h: { rank: number; holder: string; balance: string; limit: string; frozen: number; authorized: number }, supply: string): HolderRow;
  export function transferRow(p: PaymentObject): TransferRow;      // hash = tx_hash, amount = delivered_amount
  export function toIssuedTokenCsvRow(row: IssuedTokenRow): Record<string, unknown>;   // flattened, the row's keys
  // token-markets.ts (pure part)
  export interface TokenMarketFacts { price?: string; price_change?: string; price_time?: string; native_volume?: string; trades?: number }
  export interface MarketsSnapshot { day?: { total_native_volume: string; byAsset: ReadonlyMap<string, readonly StoredMarket[]> }; month?: { byAsset: ReadonlyMap<string, readonly StoredMarket[]> } }
  export function indexMarkets(markets: readonly StoredMarket[]): ReadonlyMap<string, readonly StoredMarket[]>;   // key `${currency}|${issuer}`, both sides
  export function tokenMarketFacts(s: MarketsSnapshot, t: TokenRef, native: string): TokenMarketFacts;
  export function tokenMarkets(s: MarketsSnapshot, t: TokenRef): TokenMarket[];
  ```
  The object types (`IssuedTokenRow`, `IssuedTotals`, `TokenObject`, `IssuerSettings`, `TokenMarket`, `HolderRow`, `TransferRow`) are declared in `token-objects.ts` with exactly the fields of their `*_KEYS`, optional where spec §5 marks the key `?`; `Coverage` is D3's type (what `FeatureCoverageService.coverage` returns).
  Turning (spec §5.5): a pair whose base is the token is as stored; otherwise `last` and `open` are `ratio(1, x)`; `last` is then `precision8`, `change` = `changePercent(open′, last′)`, `volume` the token's side, `counter_volume` the other, `native_volume`, `count`, `amm_pool` (when not null) as stored, `last_time` `fmtTime`. `tokenMarkets` orders by `native_volume` descending (none last), then `count` descending, at most 20. `price` from the native pair of `day` (with `price_change`, `price_time`), else of `month` (with `price_time`, no change), else absent; `native_volume` and `trades` sum the `day` pairs (`"0"` and 0 with none; both absent without a `day` set).

- [ ] **Step 1: Write the failing tests.**
  - `token-param.spec.ts`: `USD.r…` and `usd+r…` and `USD|r…` → `{ currency: 'USD' }`; `RLUSD.r…` and its 40 hex in lower case → the hex; the hex of `USD` → `USD`; `a.b.c.r…` → code `A.B.C` (the last separator splits); `MY TOKEN.r…` → its hex; `XRP.r…` → 400 `XRP cannot have an issuer` on XRPL and a token on Xahau, `XAH.r…` → 400 on Xahau; `$$.r…` (2 chars) → 400 `invalid currency`; `USD.xyz` → 400 `invalid issuer address`; `USD` alone → 400 `invalid issuer address`; an X-address issuer → 400 `invalid issuer address`; `tokenFileStem` gives `RLUSD r…` and, for a code-less hex, the hex.
  - `token-list.spec.ts`: `parseTokenListQuery` defaults and each error in order (`kind=mpt` → `invalid kind - use: issued`; `min_holders=-1`, `1e3`, `1000000001` → `invalid min_holders`; a 65-character `q` → `invalid search`; `q=%20` → none); a marker of `kind` issued decodes and the same values under another kind name are `invalid marker`; `tokenListBody` key order for a page and for `undefined`, `total_below` left out when undefined, `marker` left out on the last page.
  - `token-objects.spec.ts`: keys in each `*_KEYS` order, absent fields left out (`code` of a code-less hex, `price` without markets, `issuer_settings` when `issuer_ledger` is 0, `toml` and `toml_url` without a listing / domain); `transferFeeOf(1002000000) === '0.2'`, `(1000000000) === '0'`, `(0) === '0'`, `(1000000001) === '0.0000001'`; `shareOf('21395768.51', '182402118.55') === '0.117300'` and half-up at the 7th decimal; `issuerSettingsOf` on XRPL (`0x80000000` clawback) and on Xahau (`0x1000` clawback, `0x80000000` not); `toml_url` = `https://{domain}{profile.tomlPath}`; `toml` parsed from the stored JSON; `transferRow` drops `invoice_id` and keeps tags 0.
  - `token-markets.spec.ts`: a token on the base side and on the counter side give the same `last` (`0.41010000`) and `change` (`0.12`); the native price from `day`, from `month` without `price_change`, absent without either; `native_volume` sums only the pairs that have one; the order and the cap of 20.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- tokens` → FAIL: modules not found.
- [ ] **Step 3: Implement** the four modules.
- [ ] **Step 4: Run them to verify they pass.** Same command → PASS; `pnpm build` exits 0.
- [ ] **Step 5: Commit.** `git add apps/api/src/tokens` — `feat(api): token paths, the list query and marker, and the token objects`.

---

### Task 10: `GET /v2/tokens`

**Files:**
- Create: `apps/api/src/tokens/tokens.service.ts`, `apps/api/src/tokens/tokens.controller.ts`, `apps/api/src/tokens/tokens.module.ts`, `apps/api/test/support/tokens-seed.ts`, `apps/api/test/tokens.e2e-spec.ts`
- Modify: `apps/api/src/tokens/token-markets.ts` (the `TokenMarkets` provider), `apps/api/src/network/markets.service.ts` (`set` becomes public `newestSet(period, amm)`), `apps/api/src/network/network.module.ts` (exports `MarketsService`), `apps/api/src/app.module.ts` (`TokensModule` before `NotFoundModule`), `apps/api/src/app.module.spec.ts` (`TokensModule` imported once, before `NotFoundModule`), `apps/api/src/common/coverage-features.ts` (D3's registry: two entries), `apps/api/src/common/coverage-features.spec.ts` (D5's: the two entries' cases)

**Interfaces:**
- Consumes: Task 9; Task 4 `readTokenGenerations`, `liveGenerationOf`; D3's `COVERAGE_FEATURES`, `FeatureStart`, `FeatureCoverageService.coverage(name)` (D3's `first_ledger` case: the start is `NetworkProfile.firstLedger`, `complete: false` where that is undefined); `STATE_PARSER_VERSION`; `CacheService.wrap`; `MarketsService.newestSet`; `NETWORK_PROFILE`; `Csv`, `wantsCsv`, `setLinkHeader`.
- Produces:
  ```ts
  // coverage-features.ts: COVERAGE_FEATURES gains (D3's form, as D5 registered its four)
  issued_tokens:   { parserVersion: STATE_PARSER_VERSION, startOf: () => ({ kind: 'first_ledger' }) },
  token_transfers: { parserVersion: 1, startOf: () => ({ kind: 'first_ledger' }) },   // every stored ledger has its payments
  // tokens.service.ts
  export interface LiveTokens { generation: number; ledgerIndex: number; closeTime: number; holders: number }
  export const TOKENS_GENERATION_CACHE_MS = 5_000;
  // token-markets.ts
  export const TOKEN_MARKETS_CACHE_MS = 30_000;
  @Injectable() export class TokenMarkets { snapshot(): Promise<MarketsSnapshot> }      // the newest `include` sets of day and 30day, kept 30 s
  // tokens.service.ts; coverage() is FeatureCoverageService.coverage('issued_tokens')
  @Injectable() export class TokensService implements TokenListService<IssuedTokenRow, IssuedTotals> {
    readonly kind = 'issued';
    live(): Promise<LiveTokens | undefined>;                   // kept 5 s; close_time of through_ledger from `ledgers`
    list(q: TokenListQuery): Promise<TokenListPage<IssuedTokenRow, IssuedTotals> | undefined>;
    token(ref: TokenRef): Promise<{ live: LiveTokens; token: StoredToken } | undefined>;   // Task 11
  }
  // tokens.module.ts: providers TokensService, TokenMarkets, { provide: TOKEN_LIST_SERVICES, useFactory: (issued) => new Map([['issued', issued]]), inject: [TokensService] }
  // TokensController: @RippleController('v2/tokens'); @Get() list (@RippleRoute('unable to retrieve tokens'), @Csv('tokens', 'tokens'))
  ```

**The read** (spec §5.1; one partition):
```sql
SELECT * FROM (
  SELECT issuer, currency, code, holders, trust_lines, supply, last_ledger, issuer_ledger, issuer_flags, transfer_rate, domain, listed, name, toml,
         row_number() OVER (ORDER BY holders DESC, issuer ASC, currency ASC) AS rank
    FROM (SELECT * FROM tokens WHERE generation = {g:UInt32}
           ORDER BY issuer, currency, version DESC LIMIT 1 BY issuer, currency)
   WHERE deleted = 0 AND holders >= {min:UInt32} [AND <search>])
 [WHERE holders < {h:UInt32} OR (holders = {h:UInt32} AND (issuer, currency) > ({i:String}, {c:String}))]
 ORDER BY holders DESC, issuer, currency
 LIMIT {fetch:UInt32}
```
`<search>`: a classic address → `issuer = {q}`; else `positionCaseInsensitiveUTF8(code, {q}) > 0 OR positionCaseInsensitiveUTF8(name, {q}) > 0 OR positionCaseInsensitiveUTF8(domain, {q}) > 0 OR currency = {qhex} OR startsWith(issuer, {q})` (`qhex` the upper-cased `q` when it is 40 hex, else a value no currency has). The counts: one read over the same newest rows, `deleted = 0`: `count()` (`totals.tokens`), `countIf(holders >= 10)`, `countIf(<search> AND holders >= {min})` (`total`), and with `min_holders` > 0 `countIf(<search> AND holders < {min})` (`total_below`). `totals.holders` = `LiveTokens.holders`; `totals.native_volume` = the `day` snapshot's `total_native_volume` (absent without one). Each row gets `tokenMarketFacts`. Order of work in the controller: `parseTokenListQuery`, the kind's service from `TOKEN_LIST_SERVICES`, the marker (inside the service, before any read), `service.coverage()` and `service.list(q)` side by side, then `tokenListBody`; `setLinkHeader`; CSV `tokens.csv` (rows only, flattened). The controller knows no kind but through the map.

- [ ] **Step 1: Write the failing tests** (`coverage-features.spec.ts`: `issued_tokens` and `token_transfers` are `first_ledger` on all four profiles, with parser versions `STATE_PARSER_VERSION` and 1; `tokens.e2e-spec.ts`; `tokens-seed.ts` writes `token_generations`, `tokens` and `token_lines` rows of a live generation directly, a retired and a building generation beside it, a `ledgers` row for its `through_ledger`, and the `day` and `30day` `include` sets of `markets_live` through the markets world's seeding):
  - `it('answers the no-generation shape before any live generation')`: `{ result, coverage, kind: 'issued', count: 0, tokens: [] }`, in that key order.
  - `it('lists the live generation only, by holders, issuer, currency, with ranks')`; `it('min_holders, q (code, name, domain, hex, issuer prefix, an address), and the counts and totals')` (the board's `total_below`; totals the same whatever the filters);
  - `it('concatenated pages of limit=1, 2 and 7 equal the unpaged list, ranks included')`; `it('a marker of another kind name is invalid marker')`;
  - `it('price, change and volume from the day set in both orientations, the 30day fallback, and nothing without sets')`;
  - `it('errors in order: invalid kind - use: issued, invalid min_holders, invalid search, invalid marker')`; `it('a failed read is 500 unable to retrieve tokens')`;
  - `it('CSV tokens.csv holds the rows flattened, without coverage')`;
  - `it('reads one partition of tokens: read_rows at most its rows plus a granule per part')` (`test/support/plans.ts`, `read_rows` from `system.query_log`); `it('testnet coverage is never complete')` (the harness on D-env's `xrpl-testnet` profile: `complete: false`); `it('coverage on XRPL and Xahau from the state parser floor')`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- coverage-features` and `pnpm --filter @gatehub/data-api-service test:e2e -- tokens` → FAIL: unknown features; 404 `Cannot GET /v2/tokens`.
- [ ] **Step 3: Implement** the two registry entries, the service (its `coverage()` is `FeatureCoverageService.coverage('issued_tokens')`), `TokenMarkets`, the controller's list route, the module and the registrations.
- [ ] **Step 4: Run them to verify they pass.** Same command → PASS; `pnpm --filter @gatehub/data-api-service test` and `test:e2e -- network-markets` (the renamed set read) exit 0.
- [ ] **Step 5: Commit.** `git add apps/api/src/tokens apps/api/src/common/coverage-features.ts apps/api/src/common/coverage-features.spec.ts apps/api/src/network/markets.service.ts apps/api/src/network/network.module.ts apps/api/src/app.module.ts apps/api/src/app.module.spec.ts apps/api/test/support/tokens-seed.ts apps/api/test/tokens.e2e-spec.ts` — `feat(api): GET /v2/tokens, issued tokens ranked by holders`.

---

### Task 11: `GET /v2/tokens/{currency}.{issuer}` and `…/holders`

**Files:**
- Create: `apps/api/src/tokens/token-holders.service.ts`
- Modify: `apps/api/src/tokens/tokens.service.ts` (`token`), `apps/api/src/tokens/tokens.controller.ts` (`:token/holders`, then `:token`; the order of spec §5), `apps/api/src/tokens/tokens.module.ts`, `apps/api/test/tokens.e2e-spec.ts`, `apps/api/test/support/tokens-seed.ts`

**Interfaces:**
- Consumes: Tasks 9–10.
- Produces:
  ```ts
  @Injectable() export class TokenHoldersService {
    page(live: LiveTokens, ref: TokenRef, o: { limit: number; marker?: string }): Promise<{ rows: HolderRow[]; marker?: string }>;
  }
  // holders marker: [balance_f (Float64), holder (String)], encodeMarker/decodeMarker, as amm-paging's pools marker
  ```
  Detail: `parseTokenParam` → an LP currency is 404 `token not found` with no read → `live()` (none → 404) → the point read `WHERE generation = {g} AND issuer = {i} AND currency = {c} ORDER BY version DESC LIMIT 1` (none or deleted → 404) → `FeatureCoverageService.coverage('issued_tokens')`, the snapshot → `tokenObject`. Errors in order: the path's 400s, 404 `token not found`, 500 `unable to retrieve token`. No CSV.
  Holders: the path, `limit` (200, max 1000), the marker (before any read), the token (as the detail: 404), then:
  ```sql
  SELECT holder, balance, `limit`, frozen, authorized, rank FROM (
    SELECT holder, balance, balance_f, `limit`, frozen, authorized, row_number() OVER (ORDER BY balance_f DESC, holder ASC) AS rank
      FROM (SELECT holder, balance, balance_f, `limit`, frozen, authorized, deleted FROM token_lines
             WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
             ORDER BY holder, version DESC LIMIT 1 BY holder)
     WHERE deleted = 0 AND balance_f > 0)
   [WHERE balance_f < {b:Float64} OR (balance_f = {b:Float64} AND holder > {h:String})]
   ORDER BY balance_f DESC, holder ASC LIMIT {fetch:UInt32}
  ```
  The answer's `supply` is the token row's; `share` by `shareOf`. CSV `<stem> - holders.csv` (`@Csv` with a filename function). Errors: the path's 400s, `invalid marker`; 404 `token not found`; 500 `unable to retrieve holders`.

- [ ] **Step 1: Write the failing tests** (`tokens.e2e-spec.ts`): `it('the detail: keys, toml, toml_url, issuer settings, markets turned and ordered, last_ledger')`; `it('leaves issuer_settings out when the issuer has no state row')`; `it('Xahau names its flags by xahaud\'s table')`; `it('404 token not found before any generation, for an unknown token, a deleted row and an LP token')`; `it('the path errors in order')` (hex/`+`/`|` spellings answer the same token); `it('holders: by balance then holder, ranks, shares, frozen and authorized')`; `it('holders: equal balances are ordered by holder and pages concatenate')`; `it('holders CSV is "<code> <issuer> - holders.csv"')`; `it('the detail reads a few granules; holders read the token\'s prefix and never another token\'s')` (`read_rows` and `EXPLAIN indexes = 1`).
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test:e2e -- tokens` → the new cases FAIL.
- [ ] **Step 3: Implement** the two routes and the service.
- [ ] **Step 4: Run them to verify they pass.** Same command → PASS.
- [ ] **Step 5: Commit.** `git add apps/api/src/tokens apps/api/test/tokens.e2e-spec.ts apps/api/test/support/tokens-seed.ts` — `feat(api): one issued token and its holders`.

---

### Task 12: `GET /v2/tokens/{currency}.{issuer}/transfers`

**Files:**
- Create: `apps/api/src/tokens/token-transfers.service.ts`
- Modify: `apps/api/src/tokens/tokens.controller.ts` (`:token/transfers`, registered before `:token`), `apps/api/src/tokens/tokens.module.ts` (imports `PaymentsModule`), `apps/api/src/payments/payments.module.ts` (exports `PaymentsService`), `apps/api/test/tokens.e2e-spec.ts`, `apps/api/test/paged-reads.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 9 `parseTokenParam`, `transferRow`, `TRANSFERS_ANSWER_KEYS`; `PaymentsService.list(q: PaymentsQuery)`; `dateParam`, `endExclusive`, `bool`, `limitParam`.
- Produces: `TokenTransfersService.page(ref: TokenRef, q: Omit<PaymentsQuery, 'asset'>): Promise<{ rows: TransferRow[]; marker?: string }>` (the asset `{ currency, issuer }`, `PaymentsService.list`, rows through `transferRow`).
  Parameters and checks in order: the path's 400s, `start` (empty is none) and `end` with `/v2/payments`' messages, `descending` (default false), `limit` (200, max 1000), `marker` (`invalid marker`, from `PaymentsService`); coverage `FeatureCoverageService.coverage('token_transfers')` (Task 10's entry: parser version 1, `first_ledger`: every stored ledger has its payments); CSV `<stem> - transfers.csv`; 500 `unable to retrieve transfers`. No 404: a token the aggregate does not know lists its transfers, and so does an LP currency.

- [ ] **Step 1: Write the failing tests:** `tokens.e2e-spec.ts`: `it('transfers: the payments that delivered the token, payments to oneself left out, oldest first and descending')`; `it('transfers of a token the aggregate does not know')`; `it('transfers errors in /v2/payments\' order')`; `it('transfers CSV')`; `it('transfers coverage is token_transfers\', complete on XRPL with every ledger stored from 32570')`. `paged-reads.e2e-spec.ts`: a transfers page over the bulk reads by `readDistinctPage` within the bound of the other pages, and `expectBoundedInOrderRead` holds for its inner read.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test:e2e -- tokens paged-reads` → FAIL.
- [ ] **Step 3: Implement** the route, the service and the exports.
- [ ] **Step 4: Run them to verify they pass.** Same command → PASS; `pnpm --filter @gatehub/data-api-service test:e2e -- payments` exits 0.
- [ ] **Step 5: Commit.** `git add apps/api/src/tokens apps/api/src/payments/payments.module.ts apps/api/test/tokens.e2e-spec.ts apps/api/test/paged-reads.e2e-spec.ts` — `feat(api): the transfers of an issued token, from payments_by_currency`.

---

### Task 13: Reference, ADRs, OpenAPI, the remaining docs, verification and rollout

**Files:**
- Create: `apps/api/src/tokens/api-reference.spec.ts`, `docs/adr/0019-issued-tokens-from-state-history.md`
- Modify: `docs/api-reference.md` (section "Tokens": the four routes with parameters, real e2e answers as examples, "Keys of …, in order:" lines, errors, the definitions of spec §1, the coverage features under D3's "Coverage" convention with its no-amendment case; the Compatibility list of extras), `docs/adr/README.md`, `docs/adr/0010-ripple-v2-wire-compatibility.md` ("Amendment 8", after D5's 7: an item per route as an extra, the definitions of holders and supply, `rank` and the moving-ranking marker, transfers' relation to `/v2/payments`; item numbers the next free ones), `docs/data-model.md` (the table count), `docs/syncer.md` (the job, its place, budget, constants and hook), `docs/observability.md` (the four gauges; alert `syncer_tokens_lag_ledgers > 300` for 15 minutes), `docs/operations.md` (a forced rebuild by bumping `TOKENS_CONFIG_VERSION`; the first build's duration), `docs/architecture.md` (the job list, the module list), `docs/security.md` and `docs/clickhouse.md` (the `DROP PARTITION` the syncer needs), `docs/openapi.yaml` (regenerated, header comment kept, `docs/development.md` §8), `README.md` (the endpoint table)

**Interfaces:**
- Consumes: every `*_KEYS` constant of Tasks 9–12.
- Produces (for E11): `docs/openapi.yaml` with the four paths (E11's Task 1 syncs it) and the "Tokens" section of `docs/api-reference.md` that E11's fixture generator follows; report this task's commit hash in the hand-back.

ADR-0019 (Context, Decision, Consequences, short): tokens from the state history (ADR-0015), not from a node call; the ledger-ordered touch index and why not `meta_json`; generations built beside the live one and swapped whole, dropped by partition (the privilege); price and volume at request time; toml listings from D4's store, two-way; no node fallback; coverage from the network's first ledger.

- [ ] **Step 1: Write the failing test.** `api-reference.spec.ts` reads the "Tokens" section, takes every ``Keys of <object>, in order: `a`, `b?`, …`` line and asserts, for each object of a fixed map (`the list answer` → `TOKEN_LIST_KEYS`, `the totals` → `ISSUED_TOTALS_KEYS`, `an issued token row` → `ISSUED_TOKEN_ROW_KEYS`, `the token answer` → `TOKEN_ANSWER_KEYS`, `a token` → `TOKEN_KEYS`, `toml` → `TOKEN_TOML_KEYS`, `issuer_settings` → `ISSUER_SETTINGS_KEYS`, `a market` → `TOKEN_MARKET_KEYS`, `the holders answer`, `a holder`, `the transfers answer`, `a transfer`), that the names with `?` stripped equal the constant, and that every constant has its line.
- [ ] **Step 2: Run it to verify it fails** for the right reason (`pnpm --filter @gatehub/data-api-service test -- api-reference`); fix the reference, never a constant, until it passes.
- [ ] **Step 3: Write the docs and the ADRs, regenerate `docs/openapi.yaml`.** Measure, and record in `docs/operations.md` marked as measured on synthetic data: the account pass's rate (accounts and rows per 4 s tick) over a `trust_line_states` of 1,000,000 seeded lines in 50,000 accounts (an `INSERT … SELECT` from `numbers()` in a scratch database), and `state_touches` rows per ledger over the recorded ledgers; from them the estimated first build on XRPL and the daily `state_touches` rows, each written as an estimate with the RippleState count it assumes and where that count came from. The real figures are taken at rollout (below).
- [ ] **Step 4: Run the whole suite.** `pnpm build`, `pnpm test`, `pnpm --filter @gatehub/data-api-shared test:e2e`, `pnpm --filter @gatehub/data-syncer test:e2e`, `pnpm --filter @gatehub/data-api-service test:e2e` exit 0; `git diff --stat docs/openapi.yaml` shows the four new paths.
- [ ] **Step 5: Commit.** `git add apps/api/src/tokens/api-reference.spec.ts docs README.md` — `docs: issued tokens in the API reference, ADR-0019, the ADR-0010 items and the rollout`.

**What the owner does to deploy** (spec §10; also written in `docs/operations.md`): (1) run `migrate` (migration 014) before the new syncer starts, because the ledger writer fails without `state_touches`; (2) deploy the syncer (parser version 8; the `tokens` job builds the first generation from `trust_line_states`, hours on a full XRPL history, under 4 s a tick; watch `syncer_tokens_building` and the logged cursor); (3) deploy the api; (4) no reprocess is needed for the aggregate (the touches only matter after the first generation's head), but coverage follows the state tables, so the program's one reprocess (after its last parser version) widens it and builds a new generation on its own; (5) the syncer's ClickHouse user keeps `DROP PARTITION` on `token_lines` and `tokens` if access is ever narrowed; (6) the explorer's `TOKENS` goes on once `syncer_tokens_live` is 1 and `syncer_tokens_lag_ledgers` is under 300; (7) record the real first-build duration and the daily `state_touches` rows in `docs/operations.md`.

---

## Rulings

1. **Account touches of an `AccountSet`'s sender** (Task 2): spec §4 writes an `account` touch for a root with `Flags`, `TransferRate` or `Domain` among its `PreviousFields`; D4 §3.1 (built earlier) records that a field set for the first time is not in `PreviousFields`. The parser also touches the root of every `AccountSet`'s sender, so a first `TransferRate` or `Domain` is seen; the toml sweep catches any other domain change.
2. **Where tests and rules live:** `migrate.e2e-spec.ts` is `packages/shared/test/` (spec §12 says `apps/syncer/test/`); the pure rules are `packages/shared/src/aggregate/token-rules.ts` (and `util/currency-code.ts`) beside the SQL in `tokens.job.ts`, so spec §12's `tokens.job.spec.ts` cases are `token-rules.spec.ts` plus `tokens-job.e2e-spec.ts`.
3. **The hook's ledgers:** `agg_dirty` slices are unix seconds; the hook maps them with `RatesService.ledgersClosedIn` (as `amm_pools`' hook does), so `AggregatorTokens` carries `rates`.
4. **Test overrides:** `AggregatorTokens.configVersion` and `retiredKeepMs` default to `TOKENS_CONFIG_VERSION` and `TOKENS_RETIRED_KEEP_MS`; only tests set them.
5. **Paths:** a segment without a separator is 400 `invalid issuer address`; an LP-token path is 404 `token not found` without a read (detail, holders), while its transfers are listed (spec §5.4: no 404); a `code` decodes printable ASCII 0x20–0x7E (a space included), a 3-character path code takes 0x21–0x7E.
6. **`toml_url`** is built from `domain` and `profile.tomlPath` (D4's store holds the same text for that domain), present whenever `domain` is; the api never reads the store for tokens (spec §3.7).
7. **A stale building generation** (config or coverage changed, or an older-parser window) is written `retired` and dropped like a retired live one; only one generation builds at a time (spec §3.3).
8. **Versions** are the runner's monotonic clock, floored at start by `tokensVersionFloor` (spec §2.3: "at least one more than the key's newest").
9. **Small growths of existing code:** `exactAmount` accepts `'balance'`; `MarketsService.set` becomes the public `newestSet`; `NetworkModule` exports `MarketsService` and `PaymentsModule` `PaymentsService`.
10. **The first build's duration** (spec §10 "the plan measures it on the verification database"): no full-history database exists for this build, so Task 13 measures the pass rate on synthetic data and records an estimate; the real figure is recorded at rollout.
11. **Coverage through D3's registry** (consistency pass, replacing a descriptor argument D3 does not take): D3's `FeatureCoverageService.coverage(name)` reads a named entry of `COVERAGE_FEATURES` (`apps/api/src/common/coverage-features.ts`, D3 Ruling 4), so D6 registers `issued_tokens` (`STATE_PARSER_VERSION`) and `token_transfers` (parser version 1), both `startOf: () => ({ kind: 'first_ledger' })` (the network's first ledger, no amendment), and calls `coverage('issued_tokens')` / `coverage('token_transfers')`; each list kind answers its own `coverage()` (D9's `mpt` entry stays D9's).
12. **`pnpm lint` is not run** (consistency pass): the repository has no ESLint configuration (`docs/development.md` §4; D-env's Global Constraints), so `eslint --fix` fails; the checks before a commit and at the end are `pnpm format`, `pnpm build`, `pnpm test` and the `test:e2e` suites.
