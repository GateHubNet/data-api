# Issuer analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve exact supply, holders, distribution and flows of every issued token and MPT, at the head and at any indexed ledger, from a token
history in ClickHouse.

**Architecture:**
- The operator's `token-history-build` command builds a generation (change log, checkpoints, hourly rollups) from `trust_line_states` and `mpt_holder_states`, server-side.
- A new syncer worker, `token_history`, keeps the live generation at the head from `state_touches` and `mpt_touches`, repairs after re-ingests, and promotes finished builds.
- The api reads holders at N as the newest checkpoint plus the changes after it.

**Tech Stack:** TypeScript, NestJS 10, ClickHouse 26.8.14.3 (`@clickhouse/client`), BigNumber.js, Jest + ts-jest + testcontainers, Ajv (new, a devDependency of `apps/api`).

**Spec:** [`docs/superpowers/specs/2026-11-08-issuer-analytics-design.md`](../specs/2026-11-08-issuer-analytics-design.md); the storage decision is [ADR-0021](../../adr/0021-token-history-in-clickhouse.md).
Read both before a task. Section numbers below (§N) are the spec's.

## Global Constraints

**Data**
- Amounts are exact decimal **text** end to end (BigNumber in TypeScript); never a JS number, never a served Float64 sum (spec §3.3).
- Holder counts are exact: no HyperLogLog, no sampling.
- No `FINAL` on any read. Dedupe with `LIMIT 1 BY <key>` in a capped inner read (ADR-0003, `readDistinctPage`); keep the newest `version` by `LIMIT 1 BY`.
- Every read starts from a key prefix of its table and is bounded (spec §7). Name tables only as `${Table.X}`, and bind every value as a parameter.

**Schema**
- The migration is `packages/shared/schema/019_token_history.sql`, seven `CREATE TABLE IF NOT EXISTS` and nothing else.
- Every statement's semicolon ends its last line, and no comment line ends with `;`. Never edit an applied migration (`001`–`017`; `018` belongs to PR #26).
- Constants (spec values), in `packages/shared/src/token-history/constants.ts`:
  - `TOKEN_HISTORY_CONFIG_VERSION = 1`
  - `TOKEN_HISTORY_CHECKPOINT_FLOOR = 50_000`
  - `TOKEN_HISTORY_PASS_ACCOUNTS = 500`
  - `TOKEN_HISTORY_BUILD_THREADS = 4`
  - `TOKEN_HISTORY_LEVELS_SLICE = 5_000_000`
  - `TOKEN_HISTORY_PROMOTE_NEAR = 10`
  - `TOKEN_HISTORY_RETIRED_KEEP_MS = 900_000`
  - `TOKEN_HISTORY_POLL_MS = 1_000`
  - `TOKEN_HISTORY_PASS_BUDGET_MS = 1_000`
  - `TOKEN_HISTORY_CHECK_MS = 600_000`
  - `TOKEN_HISTORY_EXCLUDE_MAX = 20`
  - `TOKEN_HISTORY_LEDGER_WINDOW_MAX = 100_000`
  - `TOKEN_HISTORY_FLOWS_MAX_DAYS = 366`
  - `TOKEN_HISTORY_FLOWS_HOURLY_MAX_DAYS = 31`

**API**
- Errors are `{"result":"error","message":"…"}` with 400, 404 or 500, and every 400 is checked before any read.
- Successful answers send `Cache-Control: private, max-age=60`, errors `no-store`.
- Key order is pinned by `*_KEYS` constants and an `api-reference.spec.ts`, and a key with no value is left out, never `null`.
- The new messages are exactly:
  - `ledger is not in the token history yet`
  - `token history is not built yet`
  - `too many addresses to exclude`
  - `window too large for interval ledger`
  - `window too large`
  - `a ledger is required`
  - `invalid interval - use: day, hour, ledger`
  - `invalid interval - use: day, hour, month`
- Existing messages are reused exactly: `the date provided is too old`, `invalid date format`, `invalid ledger hash`, `invalid ripple address`, `invalid marker`, `token not found`, `invalid currency`, `invalid issuer address`, `issuer does not match mpt issuance`, `invalid mpt issuance id`.

**Working rules**
- Any process that talks to ClickHouse runs with `GH_CLICKHOUSE_URL` set to its own scratch server and asserts it first. `localhost:8123` is the owner's `data-api-new` stack: never touch it.
- Git:
  - work in a worktree (`superpowers:using-git-worktrees`), not in the `data-api` checkout;
  - stage named paths only (never `git add docs`);
  - no `git clean`, `reset --hard`, `--amend` or bare stash.
  - Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Push, open PRs and merge only on the owner's word. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Gates** (`docs/development.md`): `pnpm build`, `pnpm test`, and the three e2e suites `pnpm --filter @gatehub/data-api-shared test:e2e`, `pnpm --filter @gatehub/data-syncer test:e2e`,
  `pnpm --filter @gatehub/data-api-service test:e2e` (Docker).
  - A jest path pattern must be a path fragment such as `test/token-history-changes`, never a word of the worktree path.
  - Edit nothing under `apps/api/src` while the api e2e suite runs.
  - Read-bound tests drop the query condition cache (`SYSTEM DROP QUERY CONDITION CACHE`) before the measured read.

## Review Focus

The inputs the spec implies but no single task's happy path exercises; each line's test is in the task named.

1. **A line counting for two tokens at once, or turning round in one transaction.** A zero-balance line with both limits above 0 counts for both sides' tokens. A balance can also cross 0 in one transaction, so the line leaves one token and joins the other. Both tokens' `trust_lines`, `holders` and `supply` must stay exact. Tests: Task 2 (`counts for both tokens when the balance is 0 and both limits are above 0`, `a line that turns round leaves one token and joins the other`), Task 7 (`writes a change for each token of a turning line`).
2. **Extreme amounts.** 1e-81, 9.999999999999999e80, and sums past `Decimal256(30)` must sort, sum and serve exactly. Tests: Task 2 (order key), Task 4 (`exactSumOf falls back to BigNumber when an amount is unfit`), Task 22 (`summary of a token holding 9.999999999999999e80 and 1e-81 is exact`).
3. **A ledger on, just before or just after a checkpoint, or before the token's first change.**
   - Holders at N must be the same whichever side of a checkpoint N is.
   - At an N before the token's first change, the token exists in the generation but has nothing yet: 200 with zero totals and no rows, not 404.
   - Tests: Task 9 (`holdersAt equals the brute force at cp-1, cp and cp+1`), Task 24 (`snapshot before the token's first change is empty, not 404`).
4. **Paging through equal balances, and markers from elsewhere.**
   - Many holders with the same balance paged in both directions must give each holder once.
   - A D6 marker (a double) or a marker whose balance is not a number is 400 `invalid marker`.
   - Tests: Task 25 (`pages of 300 equal balances concatenate to the unpaged list in both directions`, `a D6 marker is invalid marker`).
5. **`exclude` and the token path, used oddly.**
   - `exclude` with the issuer itself, a duplicate address, or one that never held the token: figures of 0 for those, and duplicates ignored.
   - An issuance ID in lower case, or `<48hex>+<wrong issuer>`: the ID is accepted in either case; a wrong issuer is 400 `issuer does not match mpt issuance`.
   - Tests: Task 20 (`exclude ignores duplicates and accepts the issuer`, `an issuance ID in lower case is accepted`, `a wrong issuer is issuer does not match mpt issuance`), Task 22 (`without_excluded with the issuer is the whole supply`).

---

## Part 1 — PR 1: derived tables and the build

Branch `feat/token-history-1-build`, from `feature/issuer-analytics` (it carries the spec and ADR commits). Sub-issue: "Token history: derived tables and the build" under #28.

### Task 1: Migration 019, table names and row types

**Files:**
- Create: `packages/shared/schema/019_token_history.sql`
- Modify: `packages/shared/src/clickhouse/tables.ts` (the `Table` enum), `packages/shared/src/clickhouse/rows.ts`
- Test: `packages/shared/src/clickhouse/schema.spec.ts`, `packages/shared/test/migrate.e2e-spec.ts`

**Interfaces:**
- Produces:
  - **`Table` names:** `Table.TokenHolderChanges = 'token_holder_changes'`, `Table.TokenCheckpoints = 'token_checkpoints'`, `Table.TokenCheckpointHeads = 'token_checkpoint_heads'`,
    `Table.TokenHourly = 'token_hourly'`, `Table.TokenHourlyDex = 'token_hourly_dex'`, `Table.TokenHistoryState = 'token_history_state'`, `Table.TokenHistoryDirty = 'token_history_dirty'`.
  - **Row types:** `TokenHolderChangesRow`, `TokenCheckpointsRow`, `TokenCheckpointHeadsRow`, `TokenHourlyRow`, `TokenHourlyDexRow`, `TokenHistoryStateRow`,
    `TokenHistoryDirtyRow`, with the columns of spec §2.1–2.5 exactly. `UInt64` columns are `string` and amounts are `string`.
  - **`TokenHistoryStateRow`:** `state: 'building' | 'live' | 'retired'` and `phase: 'changes' | 'mpt_changes' | 'levels' | 'dex' | 'done'`.

- [ ] **Step 1: Write the failing tests.** In `schema.spec.ts`: `019 has seven CREATE TABLE IF NOT EXISTS statements and nothing else`, and `every table of 019 is in Table`.
  In `migrate.e2e-spec.ts`: `a fresh database has 92 tables`, with the existing count 85 raised to 92.
  Also pin the engines and keys from `system.tables`:
  - the four generation tables (`token_holder_changes`, `token_checkpoints`, `token_checkpoint_heads`, `token_hourly`) have a `partition_key` starting with `generation`;
  - `token_holder_changes` has `sorting_key = 'issuer, currency, ledger_index, tx_index, node_index, holder'` and `non_replicated_deduplication_window = 1000`;
  - `token_hourly` and `token_hourly_dex` are `ReplacingMergeTree(version)`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- src/clickhouse/schema` → FAIL (no file 019).
- [ ] **Step 3: Write the migration.** Partitions:
  - `token_holder_changes`: `(generation, intDiv(ledger_index, 10000000))`;
  - `token_checkpoints`: `(generation, intDiv(checkpoint_ledger, 10000000))`;
  - `token_checkpoint_heads`: `generation`;
  - `token_hourly`: `(generation, toYear(hour))`;
  - `token_hourly_dex`: `toYear(hour)`;
  - `token_history_state` and `token_history_dirty`: none.

  Head the file with the comment block in the style of `014_issued_tokens.sql`, which explains the tables. Then the `Table` entries, with a comment like D6's, and the row types.
- [ ] **Step 4: Run** the unit test, then `pnpm --filter @gatehub/data-api-shared test:e2e -- test/migrate` → PASS.
- [ ] **Step 5: Commit** `feat(shared): migration 019, the token history tables`.

### Task 2: The token side of a state row, and the order key (TypeScript)

**Files:**
- Create: `packages/shared/src/token-history/constants.ts` (the Global Constraints values), `token-side.ts`, `order-key.ts`, `index.ts` (re-exported from `packages/shared/src/index.ts`)
- Test: `packages/shared/src/token-history/token-side.spec.ts`, `order-key.spec.ts`

**Interfaces:**
- Consumes: `countsFor`, `orientations`, `LowSideLine` (`aggregate/token-rules.ts`) and `isLpCurrency` (`util/currency-code.ts`).
- Produces:
  - `interface TokenSide { issuer: string; currency: string; holder: string; amount: string; counted: boolean; limit: string; frozen: boolean; authorized: boolean; escrowed: string }`
  - `function issuedSideOf(row: { account; counterparty; currency; balance; limit_peer; freeze; authorized; deleted }): TokenSide | null`. The token of `account`, per spec §1. `null` for an LP currency. `amount` is `'0'` when not counted.
  - `function mptSideOf(row: { holder; mpt_issuance_id; amount; escrowed_amount; flags; deleted }, issuer: string): TokenSide`. `amount` is `amount + escrowed_amount` as integer text, `frozen` is `lsfMPTLocked` (0x0001), `authorized` is `lsfMPTAuthorized` (0x0002), and `limit` is `''`.
  - `function orderKeyOf(amount: string, kind: 'issued' | 'mpt'): { exp: number; mant: bigint }`. Issued: the mantissa normalised to `[10^15, 10^16)`, and `0` gives `{ exp: -32768, mant: 0n }`. MPT: `{ exp: 0, mant: BigInt(amount) }`. It throws `RangeError('amount has more than 16 significant digits')`.
  - `function compareOrderKeys(a, b): number`.

- [ ] **Step 1: Write the failing tests.**
  - **Token side:**
    - `agrees with orientations() on 5,000 generated lines`: for each generated `LowSideLine`, `issuedSideOf` of the low row and of the mirrored high row equal `orientations(line)`'s two entries (holder, balance and limit when counted; `null` and `'0'` when not).
    - `counts for both tokens when the balance is 0 and both limits are above 0`.
    - `a line that turns round leaves one token and joins the other` (balance −5 then +5: `counted` flips on each side).
    - `an LP currency has no side`.
    - `a deleted row does not count`.
  - **MPT side:** `the amount is amount plus escrowed`, `locked and authorized come from the flags`.
  - **Order key:**
    - `orders like BigNumber over generated amounts`, including `'1e-81'`, `'9.999999999999999e80'`, `'9007199254740992'`, `'9007199254740993'` and `'0'`;
    - `rejects 17 significant digits`;
    - `MPT keys order as integers up to 18446744073709551614`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- src/token-history` → FAIL.
- [ ] **Step 3: Implement** the four functions, with BigNumber for parsing (`.e` and `.c` give the exponent and the digits).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shared): the token side of a state row and the order key`.

### Task 3: The SQL forms of the token side and the order key

**Files:**
- Create: `packages/shared/src/token-history/token-side.sql.ts`
- Test: `packages/shared/test/token-history-sql-rules.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2's functions, which serve as the oracle.
- Produces:
  - `ISSUED_SIDE_COLUMNS: string`, the SELECT expressions over `trust_line_states` columns: `account AS issuer, counterparty AS holder, currency, counted, amount, limit, frozen, authorized, '0' AS escrowed`. Sign tests are on text only: negative means a leading `-`, zero means `= '0'`; a limit above 0 is `limit_peer != '0' AND NOT startsWith(limit_peer, '-')`. LP currencies are dropped by `match(currency, LP_CURRENCY)`.
  - `orderKeySql(column: string, kind: 'issued' | 'mpt'): { exp: string; mant: string }`, two SQL expressions.

- [ ] **Step 1: Write the failing tests.**
  - `ISSUED_SIDE_COLUMNS agrees with issuedSideOf on 5,000 generated rows`: insert them into a scratch `trust_line_states`, select through the expressions, and compare row by row.
  - `orderKeySql agrees with orderKeyOf on the amounts of Task 2`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test:e2e -- test/token-history-sql-rules` → FAIL.
- [ ] **Step 3: Implement** the two exports. Parse the exponent from `splitByChar('e', x)` and count digits as `exactAmount` does in `query/decimal.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shared): SQL forms of the token side and the order key`.

### Task 4: Exact sums without a Float64 fallback

**Files:**
- Modify: `packages/shared/src/query/decimal.ts` (add beside `sumOf`; `sumOf` is unchanged)
- Test: `packages/shared/src/query/decimal.spec.ts`, `packages/shared/test/token-history-sql-rules.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `exactSumColumns(column: string, alias: string): string`, which yields `sum(<exactAmount-like decimal>) AS <alias>_exact, countIf(<unfit>) AS <alias>_unfit`. It accepts any amount column, signed included.
  - `async function exactSumOf(exact: string | null, unfit: number, rowsIfUnfit: () => Promise<string[]>): Promise<BigNumber>`. With `unfit === 0` it is `new BigNumber(exact ?? 0)`; otherwise it is the BigNumber sum of `await rowsIfUnfit()`.
- Consumers: Tasks 9, 10, 22–24, which also increment `syncer_token_history_unfit_sums_total` in the syncer and log at debug level in the api.

- [ ] **Step 1: Write the failing tests.** `exactSumOf uses the decimal when nothing is unfit`, and `exactSumOf falls back to BigNumber when an amount is unfit` (with `['1e-81', '9.999999999999999e80', '1']`, the result's `toFixed()` is exact). e2e: `exactSumColumns counts 1e-81 and 1e40 as unfit`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shared): exact sums that never fall back to Float64`.

### Task 5: Flows of a transaction and the checkpoint rule

**Files:**
- Create: `packages/shared/src/token-history/flows.ts`, `checkpoint-rule.ts`
- Test: `flows.spec.ts`, `checkpoint-rule.spec.ts`

**Interfaces:**
- Produces:
  - `interface ChangeAmounts { before: string; after: string; beforeKnown: boolean }`
  - `interface Flows { issued: string; redeemed: string; clawed_back: string; transferred: string; transfers: 0 | 1; unknown_before: number }`
  - `function flowsOfTransaction(changes: ChangeAmounts[], clawback: boolean): Flows`. This is spec §1; changes with `beforeKnown = false` count only in `unknown_before`.
  - `FLOWS_BY_TX_SQL`: the same rule in SQL over `token_holder_changes`, grouped by `(issuer, currency, ledger_index, tx_index)`. It feeds Task 10 and Task 23.
  - `interface LedgerTotals { ledger_index: number; changes: number; trust_lines_after: number }`
  - `function checkpointLedgers(totals: Iterable<LedgerTotals>, changesSinceStart: number, floor = TOKEN_HISTORY_CHECKPOINT_FLOOR): number[]`. This is spec §4.3: a checkpoint at L when the changes since the last checkpoint reach `max(trust_lines_after, floor)`.

- [ ] **Step 1: Write the failing tests.**
  - `a payment from the issuer is issued`, `a redemption is redeemed`.
  - `a transfer with a fee transfers the amount and redeems the fee`: holder A −101, B +100 → transferred 100, redeemed 1.
  - `a Clawback and an AMMClawback are clawed back`.
  - `an unknown before-state is in no flow`.
  - `supply change equals issued minus redeemed minus clawed back over 2,000 generated transactions`.
  - `checkpointLedgers is deterministic and writes no more checkpoint rows than changes` (generated histories; the sum of `trust_lines_after` at the checkpoints is ≤ the total changes), and `a token with fewer than 50,000 changes and 10 lines has no checkpoint`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shared): flows of a transaction and the checkpoint rule`.

### Task 6: Generation state and the start of the head's unbroken run

**Files:**
- Create: `packages/shared/src/token-history/state.ts`, `coverage-start.ts`
- Test: `packages/shared/test/token-history-state.e2e-spec.ts`

**Interfaces:**
- Consumes: `stateCoverageStart(ch)` (`aggregate/tokens.job.ts`), `committedCheckpoint(ch)` (`ingest/ingest-state.ts`).
- Produces:
  - `readTokenHistoryStates(ch): Promise<TokenHistoryStateRow[]>`, the newest row per generation.
  - `liveTokenHistory(rows)` and `buildingTokenHistory(rows)`: `TokenHistoryStateRow | undefined`.
  - `writeTokenHistoryState(ch, row: Omit<TokenHistoryStateRow, 'version' | 'changed_at'>): Promise<void>`, whose version is the clock in ms, above the stored maximum.
  - `nextGeneration(rows): number`.
  - `unbrokenRunStart(ch, head: number): Promise<number | undefined>`: a binary search over `count()` of `ledgers` on `[a, head]`.
  - `tokenHistoryCoverageFrom(ch, head)`: `max(stateCoverageStart, unbrokenRunStart)`.
  - `rangeIngestRunning(ch): Promise<boolean>`: an `ingest_log` range whose newest row is `started`, leaving out `run_id LIKE 'live:%'`.

- [ ] **Step 1: Write the failing tests.**
  - `unbrokenRunStart finds the start of the run that reaches the head` (ledgers 10–20 and 30–50, head 50 → 30).
  - `it is the first ledger with no gap`.
  - `tokenHistoryCoverageFrom never goes below the state coverage` (a ledger of parser 2 at 35 → 36).
  - `rangeIngestRunning sees a started range and ignores live intents`.
  - `the newest state row of a generation wins`.
- [ ] **Step 2: Run** `… test:e2e -- test/token-history-state` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shared): token history state and the head's unbroken run`.

### Task 7: The build's `changes` pass (issued tokens)

**Files:**
- Create: `packages/shared/src/token-history/build/changes-pass.ts`
- Test: `packages/shared/test/token-history-changes.e2e-spec.ts`
- Modify: `packages/shared/test/tokens-world.ts` (export a helper `seedTokenHistoryWorld` that adds a `Clawback` transaction and a line whose first row is not a creation)

**Interfaces:**
- Consumes: `nextPassAccounts(ch, after, n)` (`tokens.job.ts`), `ISSUED_SIDE_COLUMNS` and `orderKeySql` (Task 3).
- Produces: `writeChangesBatch(ch, g: number, accounts: string[], coverageFrom: number, h0: number): Promise<{ rows: number }>`. It is one `INSERT … SELECT` into `token_holder_changes`:
  - `lagInFrame` gives the before-state over `(account, counterparty, currency)`, ordered by `(ledger_index, tx_index, node_index)`, on rows `>= coverageFrom`;
  - `before_known = 0` on a line's first row there when it is not a creation, that is, when it has an older row or its node was `ModifiedNode`. Rows of a line whose first row is below `coverageFrom` are known only through rows `>= coverageFrom`, so a `trust_line_states` row below `coverageFrom` never serves as a before-state;
  - `clawback` is `(ledger_index, tx_index) IN` the `tx_by_type` keys of `Clawback` and `AMMClawback`;
  - only rows with `counted_before OR counted_after` are written;
  - the dedup token is `token_history:<g>:changes:<first>-<last>`.

- [ ] **Step 1: Write the failing tests.**
  - `writes one change per counting line change, equal to a TypeScript fold of trust_line_states`: the oracle is `issuedSideOf` over the rows in key order.
  - `writes a change for each token of a turning line`.
  - `marks the first row of a line that predates the coverage as before_known 0`.
  - `marks the changes of a Clawback`.
  - `writes no LP currency`.
  - `a batch run twice writes the same rows once` (`count()` premise before the second run).
  - `stops at h0`.
- [ ] **Step 2: Run** `… test:e2e -- test/token-history-changes` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shared): the changes pass of the token history build`.

### Task 8: The build's `mpt_changes` pass

**Files:**
- Modify: `packages/shared/src/token-history/build/changes-pass.ts`
- Test: `packages/shared/test/token-history-changes.e2e-spec.ts` (an MPT `describe`), over the D9 world of `test/mpt-state-job.e2e-spec.ts`

**Interfaces:**
- Produces: `nextMptPassHolders(ch, after: string, n: number): Promise<string[]>`, and `writeMptChangesBatch(ch, g, holders: string[], coverageFrom: number, h0: number)`, with `issuer` taken from the issuance ID (`mptIssuerOf` in `util`) and `clawback` from `tx_type`.

- [ ] **Step 1: Write the failing tests.**
  - `writes one change per MPToken change with amount plus escrowed`.
  - `the sum of the after amounts of the newest rows equals mpt_issuances.outstanding_amount`.
  - `a deleted MPToken stops counting`.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(shared): the MPT changes pass of the token history build`.

### Task 9: Holders and totals at a ledger

**Files:**
- Create: `packages/shared/src/token-history/holders-at.ts`
- Test: `packages/shared/test/token-history-holders-at.e2e-spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 7.
- Produces:
  - `interface HolderAt extends Omit<TokenSide, 'issuer' | 'currency'> { first_ledger: number; last_ledger: number; exp: number; mant: string }`.
  - `checkpointAt(ch, g, token: TokenKey, n: number): Promise<number>` (0 when none).
  - `holdersAtSql(opts: { holderFilter?: 'in' }): string`. This is spec §3.1 as SQL, ready to be wrapped for ordering, paging or grouping.
  - `holdersAt(ch, g, token, n, opts?: { holders?: string[] }): Promise<HolderAt[]>`: all the counting lines, unsorted. The worker and the build use it.
  - `interface TotalsAt { supply: string; holders: number; trust_lines: number; first_ledger?: number; last_ledger?: number }` and `totalsAt(ch, g, token, n): Promise<TotalsAt>` (spec §3.2, through `exactSumOf`).

- [ ] **Step 1: Write the failing tests** over a world with a forced checkpoint (insert a head and its rows by hand at ledger `cp`):
  - `holdersAt equals the brute force at cp-1, cp and cp+1`: the oracle is `bruteForceLines(ch, n)` of `tokens-world.ts`, keyed by `lineMapKey`.
  - `totalsAt equals the sums of the brute force`.
  - `holdersAt before the token's first change is empty`.
  - `holders filter reads only the named holders`.
  - `reads at most the checkpoint's rows plus the changes after it plus 2 granules a part` (`system.query_log.read_rows`, over a bulk of other tokens, with a mutant that drops the `checkpoint_ledger` bound and must fail).
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(shared): holders and totals at a ledger`.

### Task 10: The build's `levels` phase

**Files:**
- Create: `packages/shared/src/token-history/build/levels.ts`, `packages/shared/src/token-history/hour-sets.ts`
- Test: `packages/shared/test/token-history-levels.e2e-spec.ts`

**Interfaces:**
- Consumes: `checkpointLedgers` (Task 5), `FLOWS_BY_TX_SQL` (Task 5), `holdersAtSql` (Task 9).
- Produces:
  - `nextLevelTokens(ch, g, after: TokenKey | undefined, n: number): Promise<TokenKey[]>`.
  - `buildTokenLevels(ch, g, token, upTo: number, opts?: { slice?: number; resumeFrom?: number }): Promise<{ checkpoints: number; hours: number; doneThrough: number }>`. It streams `LedgerTotals` up to `upTo` and writes each checkpoint, rows first then the head, through `INSERT … SELECT` of `holdersAtSql`. It writes the token's hour rows in one `INSERT … SELECT` with a running sum of levels.
  - `writeHourSets(ch, g, token, hours: Date[], through: number): Promise<void>`: whole rows for the given hours; levels come from the previous hour row plus the hour's net. Task 16 reuses it.

- [ ] **Step 1: Write the failing tests** (the floor is lowered to 5 through `opts`, so the worlds checkpoint).
  - `every hour row's levels equal totalsAt at the hour's last ledger`.
  - `every hour row's flows satisfy the flow identity against the previous row`.
  - `checkpoints fall where checkpointLedgers says, and each head is written after its rows` (read the heads, and assert each head's rows exist).
  - `a token larger than a slice is built in slices and gives the same rows` (`slice: 3`).
  - `running the phase again writes nothing new`: the newest versions are equal, as are the row counts after `LIMIT 1 BY`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(shared): the levels phase of the token history build`.

### Task 11: DEX hours

**Files:**
- Create: `packages/shared/src/token-history/build/dex.ts`
- Test: `packages/shared/test/token-history-dex.e2e-spec.ts`

**Interfaces:**
- Consumes: `exactSumColumns` (Task 4); the `pair_hourly` sets (`aggregate/pair-hourly.job.ts`'s readers of the newest sentinel).
- Produces:
  - `dexHoursFromPairHourly(ch, hour: Date): Promise<'written' | 'not_final'>`.
  - `dexHistoryPartition(ch, partition: number): Promise<{ hours: number }>`: one P7 partition of `exchanges`. It writes the rows and every hour's sentinel (`issuer = ''`, `currency = ''`) last.
  - `nextDexPartition(ch): Promise<number | undefined>`: the newest partition with an hour missing its sentinel, below the oldest final `pair_hourly` hour.
  - `dexThrough(ch): Promise<Date | undefined>`: the end of the newest unbroken run of sentinels.

- [ ] **Step 1: Write the failing tests** over the exchanges of the AMM e2e world (`packages/shared/test/amm-*`):
  - `a token's hour exchanged equals the brute-force sum of its base and counter amounts`;
  - `pair_hourly and the exchanges scan give the same rows for the same hour`;
  - `an unfit pair-hour is summed exactly`;
  - `an hour with no trades has a sentinel and no row`;
  - `the native currency is no token`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(shared): DEX hours of the token history`.

### Task 12: The build orchestrator

**Files:**
- Create: `packages/shared/src/token-history/build/run-build.ts`
- Test: `packages/shared/test/token-history-build.e2e-spec.ts`

**Interfaces:**
- Consumes: Tasks 6–11.
- Produces:
  - `class BuildRefused extends Error { reason: 'build_running' | 'range_ingest' | 'no_worker' }`.
  - `class BuildStopped extends Error`.
  - `interface BuildLog { info(msg: string): void }`.
  - `runTokenHistoryBuild(ch, o: { network: string; hasMpt: boolean; threads: number; log: BuildLog; now?: () => number; signal?: AbortSignal; workerLeaseFreshMs?: number }): Promise<{ generation: number; phase: 'done' }>`. It:
    - takes the lease row `<network>:token_history_build` in `syncer_lease` (refused while fresh: 30 s);
    - refuses while `rangeIngestRunning`, or while `<network>:token_history` has no fresh lease;
    - resumes a building generation of the current config and coverage, or starts one: `h0` is the commit marker, `coverage_from` is `tokenHistoryCoverageFrom`, and `through_ledger = levels_through = h0`;
    - runs `changes`, `mpt_changes` (skipped without MPT), `levels` (with `h1 = through_ledger` read when the phase starts), `dex` and `done`, writing the state row after every batch;
    - checks `rangeIngestRunning` between batches; if one has started, it writes the generation `retired` and throws `BuildStopped`;
    - sends every statement with `max_threads = threads`;
    - logs `token-history-build: generation G phase P cursor C rows R (N rows/s)`.

- [ ] **Step 1: Write the failing tests.**
  - `refuses while a range-ingest runs`, `refuses while another build holds the lease`, `refuses without a fresh worker lease`.
  - `stops and retires the generation when a range-ingest starts`.
  - `resumes after an abort in every phase and gives the same tables as an uninterrupted build`: abort through `signal` after the first batch of each phase, compare `LIMIT 1 BY`-deduplicated contents.
  - `a build ends with phase done and levels_through = h1`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(shared): the token history build`.

### Task 13: The `token-history-build` command

**Files:**
- Create: `apps/syncer/src/cli/token-history-build.ts`, `token-history-build.spec.ts`
- Modify: `apps/syncer/package.json` (script `token-history:build`, which runs `dist/cli/token-history-build.js`), `apps/syncer/Dockerfile` (the usage comment gains `node dist/cli/token-history-build.js [--threads N]`, and the builder's check gains `&& test -f /app/out/dist/cli/token-history-build.js` beside `range-ingest.js`'s; `dist/` is already copied whole)
- Test: `apps/syncer/test/token-history-build-cli.e2e-spec.ts`

**Interfaces:**
- Consumes: `runTokenHistoryBuild` (Task 12), the syncer config loader and the network profile.
- Produces: the CLI `token-history-build [--threads N]`. Exit codes: 0 when done, 2 when refused (the message names the reason), 3 when stopped, 1 on an error. SIGINT aborts the batch in flight, and the build resumes on the next run.

- [ ] **Step 1: Write the failing tests.** Unit: `parses --threads and defaults to 4`, `rejects --threads 0`. e2e (as `range-ingest-cli.e2e-spec.ts`): `exits 2 with "a range-ingest is running" while one runs`, `exits 0 and leaves a done generation`. The e2e asserts `GH_CLICKHOUSE_URL` is the test container's before spawning.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(syncer): the token-history-build command`.

### Task 14: Measure the build, and open PR 1

**Files:**
- Create: `docs/superpowers/plans/2026-11-08-issuer-analytics.verification.md` (section "Build measurement")

- [ ] **Step 1:** Start a scratch ClickHouse 26.8.14.3 (`docker run -d -p 18123:8123 clickhouse/clickhouse-server:26.8.14.3`), set `GH_CLICKHOUSE_URL=http://127.0.0.1:18123`, and assert it.
- [ ] **Step 2:** Seed the D6 synthetic shape of `docs/operations.md` "Measured on synthetic data" (1x and 8x), and run `token-history-build` with `--threads 4`. A fake worker lease row stands in for the worker.
- [ ] **Step 3:** Record per phase: rows read and written, rows/s, peak `memory_usage`, and the disk of each table (`system.parts`). Extrapolate the figures of spec §9 and §2.6 from the measured rates, stating the assumptions.
- [ ] **Step 4:** Run every gate (Global Constraints).
- [ ] **Step 5: Commit** `docs: token history build measurement`. On the owner's word: push, then `gh pr create --base master` with the sub-issue linked (`Closes #<sub-issue>`, `Part of #28`).

---

## Part 2 — PR 2: syncer integration

Branch `feat/token-history-2-worker`, from PR 1's branch. Sub-issue: "Token history: the token_history worker".

### Task 15: The worker's skeleton: name, module, schema check, lease, loop

**Files:**
- Modify:
  - `apps/syncer/src/config/syncer.config.ts`: `WORKER_NAMES` gains `'token_history'` (last); the default of `GH_WORKERS` follows.
  - `apps/syncer/src/worker-registry.ts`: `token_history: TokenHistoryModule`; it is not in `NODE_CLIENT_WORKERS`.
  - `apps/syncer/src/core/schema-check.ts`: `TOKEN_HISTORY_MIGRATION = '019_token_history.sql'`. The needs: `token_history` needs the seven tables of 019 and `state_touches`, `trust_line_states`, `mpt_touches`, `mpt_holder_states`, `tx_by_type`, `pair_hourly`; `aggregator` needs `token_history_dirty`.
- Create: `apps/syncer/src/token-history/token-history.module.ts`, `token-history-worker.ts`, `token-history-lease.ts`
- Test: `syncer.config.spec.ts`, `worker-registry.spec.ts`, `schema-check.spec.ts`, `token-history-lease.spec.ts`, `token-history-worker.spec.ts`

**Interfaces:**
- Consumes: `PassLoop` (`core/pass-loop.ts`, as the tomls worker uses it).
- Produces:
  - `class TokenHistoryLease { take(): Promise<void>; heartbeat(): Promise<void>; release(): Promise<void> }`, on the `syncer_lease` row `<network>:token_history`, with the live runner's TTL (30 s) and heartbeat (10 s). `take` refuses a fresh foreign holder.
  - `class TokenHistoryWorker` with `pass(): Promise<void>`, which the next tasks fill. The order of a pass is: live windows until caught up, then within the budget one step of catch-up, repair or live DEX.

- [ ] **Step 1: Write the failing tests.**
  - `GH_WORKERS accepts token_history and the default includes it`.
  - `the token_history worker needs no node client`.
  - `a database without 019 refuses the token_history worker with "lacks the schema of 019_token_history.sql"`.
  - `the lease is refused while another fresh holder has it, and taken after its TTL`.
  - `a pass does nothing without a committed ledger`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(syncer): the token_history worker, its lease and schema check`.

### Task 16: Live windows

**Files:**
- Create: `packages/shared/src/token-history/live-window.ts`
- Test: `packages/shared/test/token-history-live.e2e-spec.ts`

**Interfaces:**
- Consumes: `touchesOfWindow`, `parserFloorOf`, `LINE_STATES_SQL` shape (`tokens.job.ts`), `issuedSideOf`, `mptSideOf`, `orderKeyOf`, `writeHourSets`, `checkpointLedgers`, `holdersAtSql`.
- Produces: `applyLiveWindow(ch, gens: TokenHistoryStateRow[], head: number, o: { hasMpt: boolean }): Promise<{ to: number; changes: number }>`. It:
  - writes change rows to the live and building generations;
  - writes hour sets and checkpoints only in generations whose `levels_through >= from`;
  - writes each state row last (`through_ledger`, and `levels_through` where levels ran);
  - is never applied to a window holding a ledger of a parser below `TOKEN_PARSER_VERSION`, or below `MPT_PARSER_VERSION` on an MPT network. It throws `OlderParserWindow` there.

- [ ] **Step 1: Write the failing tests.**
  - `build equals live`: generation A is built by `runTokenHistoryBuild` over ledgers 1–N. Generation B is built up to ledger k < N, with live windows over (k, N]. Every table's deduplicated contents are equal.
  - `a window applied twice changes nothing`.
  - `a crash before the state row is invisible and redone`: abort after the hour sets; readers capped at `levels_through` see the old state; reapplying gives the full one.
  - `a building generation in changes gets change rows only`.
  - `a window of an older parser is refused`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(shared): live windows of the token history`.

### Task 17: Catch-up, promotion and drop

**Files:**
- Create: `packages/shared/src/token-history/promote.ts`
- Modify: `apps/syncer/src/token-history/token-history-worker.ts`
- Test: `packages/shared/test/token-history-promote.e2e-spec.ts`, `apps/syncer/test/token-history-worker.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `catchUpLevels(ch, gen, through: number, budgetMs: number): Promise<number>` (new `levels_through`), with the live window's level logic over `(levels_through, through]`.
  - `promoteIfCaughtUp(ch, gens): Promise<boolean>`: a `live` row, then a `retired` row for the old generation, when `levels_through >= through_ledger - TOKEN_HISTORY_PROMOTE_NEAR`.
  - `dropRetired(ch, gens, now): Promise<number[]>`: `ALTER TABLE … DROP PARTITION` over the four generation tables, 15 min after `retired`, after checking the generation with `Number.isInteger`.

- [ ] **Step 1: Write the failing tests.**
  - `a done build is caught up and promoted, and readers switch at the live row`.
  - `the first build is promoted with no generation to retire`.
  - `a retired generation is dropped after 15 minutes and not before`.
  - Worker e2e `the worker follows a synthetic chain, catches up a build and promotes it`, using `synthetic-chain.ts` and a writer.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat: catch-up and promotion of a token history build`.

### Task 18: Repair, the eighth hook, and the `rebuild_needed` reasons

**Files:**
- Create: `packages/shared/src/token-history/repair.ts`, `rebuild-needed.ts`
- Modify: `apps/syncer/src/aggregator/aggregator.service.ts` (`hooksOfSlice`: after `mptState`'s hook, `appendTokenHistoryDirty(ch, firstLedger, lastLedger)`, run with or without the worker)
- Test: `packages/shared/test/token-history-repair.e2e-spec.ts`, `apps/syncer/src/aggregator/aggregator.service.spec.ts`, `aggregator.schedule.spec.ts`

**Interfaces:**
- Produces:
  - `appendTokenHistoryDirty(ch, from, to)`.
  - `repairOldestRange(ch, gens): Promise<'none' | 'repaired' | 'dropped' | 'older_parser'>` (spec §4.7).
  - `type RebuildReason = 'none' | 'coverage' | 'config' | 'repair'`.
  - `rebuildNeeded(ch, gens, head): Promise<RebuildReason | undefined>`.

- [ ] **Step 1: Write the failing tests.**
  - `a reprocess of a range gives the same answers`.
  - `a changed state row in the range changes exactly its tokens`: totals of the others are unchanged.
  - `a range below the live coverage is dropped`.
  - `a range of an older parser is not repaired and sets reason repair`.
  - `filling a gap that joins the head's run sets reason coverage`.
  - `a config bump sets reason config`.
  - Aggregator unit: `the token history hook runs after mpt_state's and appends the slice's ledgers`, and `it runs without the token_history worker`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat: token history repair, its agg_dirty hook and rebuild reasons`.

### Task 19: Live DEX, metrics, and opening PR 2

**Files:**
- Modify: `apps/syncer/src/token-history/token-history-worker.ts`, `apps/syncer/src/modules/prometheus/prometheus.service.ts`
- Test: `prometheus.service.spec.ts`, `token-history-worker.spec.ts`

**Interfaces:**
- Produces the metrics of spec §4.8:
  - `syncer_token_history_lag_ledgers` (gauge);
  - `syncer_token_history_rebuild_needed{reason}` (gauge, `remove()` when none);
  - `syncer_token_history_building{phase}`;
  - `syncer_token_history_window_seconds` (histogram);
  - `syncer_token_history_errors_total{step}` (seeded 0 for `live`, `repair`, `catch_up`, `dex`, `drop`);
  - `syncer_token_history_unfit_sums_total`.
- The worker calls `dexHoursFromPairHourly` for each hour newer than `dexThrough` whose `pair_hourly` set is final. It logs once per reason when a build is due.

- [ ] **Step 1: Write the failing tests.** `the metrics are registered and seeded`, `rebuild_needed shows none on an empty database`, `the worker writes the DEX hour once pair_hourly is final`, `an error in one step is counted and the next pass runs`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5:** Run every gate.
- [ ] **Step 6: Commit** `feat(syncer): token history DEX hours and metrics`. On the owner's word: push and `gh pr create --base feat/token-history-1-build`.

---

## Part 3 — PR 3: read endpoints

Branch `feat/token-history-3-routes`, from PR 2's branch. Sub-issue: "Token history: read endpoints".

### Task 20: Parameters, the generation and coverage service

**Files:**
- Create in `apps/api/src/token-history/`: `token-history.module.ts`, `token-history-param.ts`, `token-history-ledger.ts`, `exclude-param.ts`, `token-history.service.ts`, `token-history-coverage.ts`
- Modify: `apps/api/src/app.module.ts` (`ENDPOINT_MODULES`: `TokenHistoryModule` before `NotFoundModule`), `app.module.spec.ts`
- Test: `*.spec.ts` beside each file

**Interfaces:**
- Consumes: `parseTokenParam` (`tokens/token-param.ts`), `parseIssuanceIdParam` (`mpt/mpt-param.ts`), `ledgerSelector` and `DATE_TOO_OLD` (`accounts/account-ledger.ts`), `LedgerRangeResolver`, `CacheService`.
- Produces:
  - `type AnyToken = { kind: 'issued'; currency: string; issuer: string } | { kind: 'mpt'; currency: string; issuer: string }`, and `parseAnyToken(raw: string, native: 'XRP' | 'XAH'): AnyToken`. Forty-eight hex digits (any case) make an MPT. `<48hex>+<issuer>` checks the issuer, with `issuer does not match mpt issuance`.
  - `parseExclude(q): string[] | undefined`: sorted and deduplicated, at most 20, each `isValidClassicAddress`.
  - `TokenHistoryService.live(): Promise<{ generation: number; through: number; close_time: number; coverage_from: number } | undefined>`, cached 5 s under one key.
  - `resolveTokenHistoryLedger(q, live, opts: { required?: boolean }): Promise<number>`. The messages are those of the Global Constraints, in this order: `a ledger is required`, the selector's own messages, `ledger is not in the token history yet`, `the date provided is too old`.
  - `tokenHistoryCoverage(live, profile, mptStart: number | undefined, kind)`: `{ from_ledger_index, complete }` (spec §6).

- [ ] **Step 1: Write the failing tests.**
  - `an issuance ID in lower case is accepted`, `a wrong issuer is issuer does not match mpt issuance`.
  - `exclude ignores duplicates and accepts the issuer`, `21 addresses is too many addresses to exclude`.
  - `a ledger above through is ledger is not in the token history yet`, `a ledger below coverage_from is the date provided is too old`.
  - `coverage is complete from the first ledger and false above it`, `MPT coverage is complete from the MPTokensV1 ledger`.
  - `TokenHistoryModule is before NotFoundModule`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(api): token history parameters, generation and coverage`.

### Task 21: Objects, JSON Schemas, Ajv and the digest

**Files:**
- Create: `apps/api/src/token-history/token-history-objects.ts` (`*_KEYS`, the builders, the CSV rows), `apps/api/src/token-history/schemas.ts`, `apps/api/test/support/ajv.ts`, `packages/shared/src/token-history/digest.ts`
- Modify: `apps/api/package.json` (devDependencies `ajv@^8.17.1`, `ajv-formats@^3.0.1`)
- Test: `token-history-objects.spec.ts`, `schemas.spec.ts`, `packages/shared/src/token-history/digest.spec.ts`

**Interfaces:**
- Produces:
  - `ISSUER_TOKEN_KEYS`, `SUMMARY_KEYS`, `SUMMARY_WINDOW_KEYS`, `SUPPLY_ROW_KEYS`, `DISTRIBUTION_KEYS`, `BUCKET_KEYS`, `FLOWS_KEYS`, `FLOWS_TOTALS_KEYS`, `COUNTERPARTY_KEYS`, `SNAPSHOT_KEYS`, `SNAPSHOT_ROW_KEYS`, and `HOLDER_ROW_EXTRA_KEYS = ['first_ledger', 'last_ledger', 'escrowed']`, in spec §5's orders.
  - `schemas.ts` exports one JSON Schema per route (`ISSUER_TOKENS_SCHEMA`, …, `HOLDERS_SCHEMA`), with `required` and `additionalProperties: false` at every level. Amounts use `AMOUNT = { type: 'string', pattern: '^\\d+(\\.\\d+)?(e[-+]?\\d+)?$' }`; `net` uses the signed pattern.
  - `expectSchema(body: unknown, schema: object): void` (test support).
  - `snapshotDigest(lines: Iterable<{ holder: string; balance: string }>): string`: lower-case hex SHA-256 of `<holder>,<balance>\n` lines in the given order.

- [ ] **Step 1: Write the failing tests.**
  - `the digest of the empty set is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
  - `the digest of rA,1 and rB,2.5 is 7026d968e9ec57f2fee6c54aefb39a9a9ba0124f6900af79799c4e003c0dc589` (`printf 'rA,1\nrB,2.5\n' | shasum -a 256`).
  - `every schema rejects a number amount and an extra key`.
  - `the builders give the keys in their *_KEYS order and leave absent keys out`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(api): token history objects, schemas and the snapshot digest`.

### Task 22: `GET /v2/issuers/{issuer}/tokens` and `GET /v2/tokens/{token}/summary`

**Files:**
- Create in `apps/api/src/token-history/`: `issuers.controller.ts` (`@RippleController('v2/issuers')`), `token-summary.controller.ts` (`@RippleController('v2/tokens')`, route `:token/summary`), `token-history-reads.service.ts`
- Create: `packages/shared/src/token-history/reads.ts` (`issuerTokensAt`, `windowFlows`)
- Test: `apps/api/test/token-history.e2e-spec.ts` (new suite, seeded through `seedTokenHistoryWorld`, then `runTokenHistoryBuild` and promotion)

**Interfaces:**
- Produces:
  - `issuerTokensAt(ch, g, issuer, n, page: { after?: string; limit: number }): Promise<IssuerTokenRow[]>`.
  - `windowFlows(ch, g, token, fromLedger, toLedger): Promise<Flows & { changes: number }>`: whole hours from `token_hourly`, edges from the change log (spec §3.5).
  - `dexOfWindow(ch, token, fromHour, toHour): Promise<{ exchanged: string; trades: number; through?: Date } | undefined>`.
- Routes:
  - the issuers route uses `@RippleRoute('unable to retrieve tokens')`, with `@Csv` stem `<issuer> - tokens`;
  - the summary route uses `@RippleRoute('unable to retrieve token summary')`, with no CSV.
  - Each has its `@ApiOperation`, `@ApiParam`, `@ApiQuery` and `@ApiOkResponse({ schema })`.

- [ ] **Step 1: Write the failing tests.**
  - `issuer tokens lists issued tokens and MPTs by currency and pages`, `an issuer with no token is an empty list`.
  - `summary totals equal the brute force at the head and at a past ledger`.
  - `the 24h window flows equal the sum of the brute-force flows of its ledgers`.
  - `exchanged is absent before the DEX history and present after, with exchanged_through`.
  - `summary of a token holding 9.999999999999999e80 and 1e-81 is exact`.
  - `without_excluded with the issuer is the whole supply`.
  - `404 token history is not built yet before the first generation`, `404 token not found for an unknown token`.
  - `on Xahau an issuance ID is token not found and no MPT table is read` (Xahau harness, `system.query_log` has no read of an MPT table).
  - `every answer validates against its schema`.
- [ ] **Step 2: Run** `NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @gatehub/data-api-service test:e2e -- test/token-history.e2e` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api): issuer tokens and token summary`.

### Task 23: `GET /v2/tokens/{token}/supply` and `/flows`

**Files:**
- Create: `apps/api/src/token-history/token-supply.controller.ts`, `token-flows.controller.ts`
- Modify: `packages/shared/src/token-history/reads.ts` (`supplySeries`, `flowsPeriods`, `topCounterparties`)
- Test: `apps/api/test/token-history.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `supplySeries(ch, g, token, o: { interval: 'day' | 'hour' | 'ledger'; from: number; to: number; descending: boolean; after?: string | number; limit: number; exclude?: string[] })`. `hour` and `day` emit every bucket, with levels carried forward; `ledger` emits the ledgers with changes, at most 100,000 of them.
  - `flowsPeriods(…, interval: 'day' | 'hour' | 'month')`.
  - `topCounterparties(ch, g, token, fromLedger, toLedger, n): Promise<Counterparty[]>`, ranked by `received + sent`, then by account.
  - Markers: `[bucket_start_unix]` for hour and day, `[ledger_index]` for ledger.

- [ ] **Step 1: Write the failing tests.**
  - `day buckets carry levels forward and sum their hours`.
  - `interval ledger lists the ledgers with changes`, `interval ledger over 100,001 ledgers is window too large for interval ledger`.
  - `pages concatenate to the unpaged series in both directions`.
  - `exclude adds without_excluded to every row`.
  - `flows totals equal the sum of the periods`, `top counterparties equal the brute force`.
  - `367 days is window too large`, `hour over 32 days is window too large`.
  - Every schema validates.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(api): token supply series and flows`.

### Task 24: `GET /v2/tokens/{token}/distribution` and `/snapshot`

**Files:**
- Create: `apps/api/src/token-history/token-distribution.controller.ts`, `token-snapshot.controller.ts`
- Modify: `packages/shared/src/token-history/reads.ts` (`distributionAt`, `snapshotPage`, `snapshotDigestAt`)
- Test: `apps/api/test/token-history.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `distributionAt(ch, g, token, n, exclude?)`: decade buckets by order key, empty middles kept, with `top` 10 and 100 and shares at 6 decimals half up (D6's `share` helper).
  - `snapshotPage(ch, g, token, n, after?: string, limit: number)`, ordered by `holder`.
  - `snapshotDigestAt(ch, g, token, n): Promise<string>`: a ClickHouse `SHA256` over the sorted concatenation, pinned against `snapshotDigest`.
  - The snapshot route takes `limit` up to 10,000 (default 1000) and the CSV stem `<code or currency> <issuer> - snapshot <ledger_index>`.

- [ ] **Step 1: Write the failing tests.**
  - `distribution buckets count every holder once and sum to the supply`.
  - `snapshot balances equal the brute force at a past ledger, and every page has the same digest`.
  - `the ClickHouse digest equals snapshotDigest over the same set`.
  - `snapshot before the token's first change is empty, not 404`.
  - `snapshot without a ledger is a ledger is required`.
  - `snapshot of an MPT has escrowed and its balance includes it`.
  - Every schema validates.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(api): token distribution and snapshot`.

### Task 25: D6's `/holders`, extended

**Files:**
- Modify: `apps/api/src/tokens/tokens.controller.ts` (the `:token/holders` route), `apps/api/src/tokens/token-holders.service.ts`, `apps/api/src/tokens/token-objects.ts` (`HOLDER_KEYS` + `HOLDER_ROW_EXTRA_KEYS`)
- Create: `packages/shared/src/token-history/holders-page.ts`
- Test: `apps/api/test/tokens.e2e-spec.ts` (the existing holders cases must still pass unchanged before the switch), `apps/api/test/token-history.e2e-spec.ts`

**Interfaces:**
- Consumes: `TokenHistoryService.live()`, `holdersAtSql`.
- Produces:
  - `holdersPage(ch, g, token, n, o: { descending: boolean; after?: { balance: string; holder: string }; limit: number })`: ranks over the whole set, ordered by `(exp, mant, holder)`.
  - The marker becomes `base64url(JSON [balanceText, holder])`. A D6 marker (a JSON number first) or a balance that is not a decimal is 400 `invalid marker`.
  - Before a generation is live, the route is D6's code path unchanged, and a ledger parameter is 404 `token history is not built yet`.

- [ ] **Step 1: Write the failing tests.**
  - `before the first generation the answer is D6's, byte for byte` (snapshot of the current answer).
  - `after promotion the keys are D6's, then first_ledger and last_ledger`.
  - `holders at a past ledger equal the brute force`.
  - `pages of 300 equal balances concatenate to the unpaged list in both directions`.
  - `a D6 marker is invalid marker`.
  - `an MPT ID lists its holders with escrowed`.
  - `the schema validates`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(api): /v2/tokens/{token}/holders reads the token history`.

### Task 26: Read bounds, the mainnet check script, and opening PR 3

**Files:**
- Modify: `apps/api/test/paged-reads.e2e-spec.ts`, `apps/api/test/support/plans.ts` (plan tests)
- Create: `apps/syncer/src/cli/token-history-check.ts` (the mainnet comparison, not run in CI), `token-history-check.spec.ts`

**Interfaces:**
- Produces: `token-history-check --api <url> --key-env NAME --node <wss> --tokens <file> --ledgers <n,…>`. For each pair it compares `/snapshot`'s balances with the issuer's `account_lines` and `gateway_balances` at the ledger, one request in flight, and writes a report of matches, differences and skipped samples to stdout.

- [ ] **Step 1: Write the failing tests.**
  - `paged-reads`: every new route's reads stay under its bound of spec §7 over a bulk of other tokens, with one mutant per bound.
  - Plan tests: `the change-log read is a ReadFromMergeTree on the token prefix, with no FINAL`.
  - Unit: `the check compares balances exactly and reports a difference`, using a fake node and a fake api.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5:** Run every gate.
- [ ] **Step 6: Commit** `test(api): token history read bounds; feat(syncer): token-history-check`. On the owner's word: push, `gh pr create --base feat/token-history-2-worker`.

---

## Part 4 — PR 4: OpenAPI and docs

Branch `feat/token-history-4-docs`, from PR 3's branch. Sub-issue: "Token history: OpenAPI and docs".

### Task 27: OpenAPI, the API reference and ADR-0010 Amendment 12

**Files:**
- Modify:
  - `docs/openapi.yaml`, regenerated by its header's three steps; its header comment says the token history routes carry response schemas.
  - `docs/api-reference.md`: a section per route after D6's Tokens, the `/holders` changes, the "Keys of" lines and "Differences from data.ripple.com: none".
  - `docs/adr/0010-ripple-v2-wire-compatibility.md`: Amendment 12, items 118 onward, and its status line.
  - `docs/adr/0019-issued-tokens-from-state-history.md`: one appended note that ADR-0021 keeps the history it deferred.
- Test: `apps/api/src/token-history/api-reference.spec.ts` (create: the reference's "Keys of" lines equal the `*_KEYS`)

- [ ] **Step 1:** Write `api-reference.spec.ts` (`the reference lists the keys of every token history object in order`) → FAIL.
- [ ] **Step 2:** Write the reference sections → PASS.
- [ ] **Step 3:** Regenerate `openapi.yaml`, and check `git diff --stat docs/openapi.yaml` shows only the new paths, `/holders` and the header.
- [ ] **Step 4: Commit** `docs: token history routes in the API reference, OpenAPI and ADR-0010`.

### Task 28: The other documents and the glossary

**Files:**
- Modify:
  - `GLOSSARY.md`: the terms of spec §1 (token side, change, issued, redeemed, clawed back, exchanged, token history, checkpoint), in the file's format, each with its `_Avoid_`.
  - `docs/data-model.md`: the seven tables, 85 → 92, the relationships and migration 019.
  - `docs/syncer.md`: the worker and the eighth hook.
  - `docs/architecture.md`.
  - `docs/clickhouse.md`: the reads, and `ALTER DELETE` on the four generation tables.
  - `docs/operations.md`: the build as measured in Task 14, the command, a forced rebuild, the alerts and retention.
  - `docs/backfill.md`: what a fill and a reprocess do to the token history.
  - `docs/observability.md`: the six metrics and two alerts.
  - `docs/configuration.md`: `GH_WORKERS` gains `token_history`.

- [ ] **Step 1:** Write each document's section. Check every table count, metric name, message and constant against the code (`grep` each name in `packages/` and `apps/`).
- [ ] **Step 2:** Run every gate (the docs touch no code, so the unit suites and `pnpm build` are enough, plus `api-reference.spec.ts`).
- [ ] **Step 3: Commit** `docs: token history in the data model, syncer, operations and glossary`. On the owner's word: push, `gh pr create --base feat/token-history-3-routes`.

### Rollout (after the stack is merged; for the owner, not a task)

1. `migrate` (019).
2. Deploy the syncer and the api.
3. `range-ingest` from 32,570.
4. `token-history-build`.
5. `token-history-check` against a GateHub node, EURGH among the tokens, with its report added to the verification file.
