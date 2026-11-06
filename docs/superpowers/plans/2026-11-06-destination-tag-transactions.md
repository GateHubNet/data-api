# Transactions by destination tag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /v2/accounts/{address}/transactions?destination_tag=T` lists every transaction whose own `Destination` is the address and whose own `DestinationTag` is T. It reads a new ledger table `account_tx_by_destination_tag`, which ingest writes from parser version 11, and the answer carries `coverage`.

**Architecture:** A pure `DestinationTagParser` reads the two fields of a transaction. `buildLedgerRows` turns its answer into a row of a new ledger-keyed table (migration 018), so recovery and `--reprocess` treat the table like every other ledger table, and the syncer's ingest refuses to boot without it. `AccountTransactionsService.listByDestinationTag` pages the table by its key with the time list's window, filters and marker, then fetches the page's transactions exactly as the time list does, and adds `FeatureCoverageService.coverage('destination_tags')`. The controller adds the parameter, its two 400s and the export count. Without the parameter, nothing changes.

**Tech Stack:** TypeScript (strict), NestJS 10, ClickHouse 26.8 (`@clickhouse/client`), pnpm 10 workspace, jest + ts-jest, testcontainers, supertest.

**Spec:** `docs/superpowers/specs/2026-11-06-destination-tag-transactions-design.md` (approved by the owner on 2026-11-06; cited as "spec §n"). Executors read both.

**Branch:** `feat/destination-tag-transactions` in `/Users/golobitch/github.com/GateHubNet/data-api-worktrees/destination-tag`, on top of `feat/explorer-data-2` (#21: migration 017, parser version 10). Nothing is pushed.

## Global Constraints

- **Numbers (checked in Task 1, Step 1):**
  - migration `packages/shared/schema/018_destination_tags.sql`
  - `PARSER_VERSION` goes from 10 to 11, and `DESTINATION_TAG_PARSER_VERSION = 11` (`packages/shared/src/clickhouse/rows.ts`)
  - ADR `docs/adr/0021-transactions-by-destination-tag.md`
  - ADR-0010 "Amendment 12", items numbered from 118 (Amendment 11 ends at 117)
  - tables per network database go from 85 to 86 (ledger-derived tables from 40 to 41)
  - `docs/openapi.yaml` keeps its 105 paths and gains one parameter

  If a check finds another value, use the next free one and change every reference to it.
- **Commands:**
  - Run `pnpm install --frozen-lockfile` once if `node_modules` is missing (this plan adds no dependency).
  - The apps import the compiled `dist/` of `packages/shared`: after a shared change, run `pnpm --filter @gatehub/data-api-shared build` before an app's tests.
  - A narrow run is `pnpm --filter <pkg> test <pattern>` or `pnpm --filter <pkg> test:e2e <pattern> -t '<name>'`, never with `--`.
  - The e2e suites start their own ClickHouse (testcontainers set `GH_CLICKHOUSE_URL`). That variable has no default, and nothing may point at `localhost:8123`, which is the local Docker stack.
  - Before each commit:
    - `pnpm exec prettier --write <the .ts files of the commit>` (code files only, never markdown)
    - `pnpm build`
    - `pnpm test`
    - the `test:e2e` suite of each package the task touched
- **Commits:**
  - Conventional Commits (`feat(shared): …`, `feat(syncer): …`, `feat(api): …`, `test(api): …`, `docs: …`), with a body that says why, ending in the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Name the files: never `git add -A` or `git add .`. Never `--amend`, never push.
  - Never touch `.claude/`, npm tokens, `~/.npmrc` or any `data-api-new-*` container.
- **Repo conventions** (`docs/development.md` §5):
  - table names only from `Table`
  - every user value is a bound parameter
  - no `FINAL`
  - key-ordered page reads through `readDistinctPage`
  - everything new in `packages/shared` is exported from `packages/shared/src/index.ts`
- **The rule (spec §5):**
  - A row for every transaction of a ledger whose `Destination` is a string and whose `DestinationTag` is an integer from 0 to 4,294,967,295.
  - Any type and any result count, `tec` included. Batch inner transactions count like any other.
  - Anything else gives no row, and nothing throws.
  - The rule reads the two fields, never a list of types.
- **The table (spec §4)**, exactly:
  - columns: `account String, destination_tag UInt32, ledger_index UInt32, tx_index UInt32, tx_type LowCardinality(String), result LowCardinality(String), close_time DateTime('UTC')`
  - engine `ReplacingMergeTree`
  - `PARTITION BY intDiv(ledger_index, 10000000)` (P7)
  - `ORDER BY (account, destination_tag, ledger_index, tx_index)`
  - `SETTINGS non_replicated_deduplication_window = 1000`
- **The route (spec §6):**
  - The new messages, exactly: 400 `invalid destination_tag` and 400 `destination_tag cannot be combined with min_sequence or max_sequence`.
  - Every other message, and the 500 `unable to retrieve transactions`, stays the route's own.
  - A tagged answer's keys, in order: `result, coverage, count, marker?, transactions`. The CSV has no `coverage`.
  - Without `destination_tag`, the answer and every SQL statement of the route stay as they are.
- **Coverage:** the `COVERAGE_FEATURES` entry `destination_tags: { parserVersion: DESTINATION_TAG_PARSER_VERSION, startOf: () => ({ kind: 'first_ledger' }) }`, in the form of `issued_tokens`. It is complete only from ledger 32,570 on the XRP Ledger and ledger 1 on Xahau, and never on a testnet.
- **Recorded data:** the parser tests use recorded ledgers where they exist. Each synthetic case says that it is synthetic, which recorded case it was edited from, and how. No new recording is made.

Plan decisions (the spec leaves these open):
1. **The order of the checks:**
   1. `limit`, `min_sequence`, `max_sequence`, as today
   2. the value of `destination_tag`
   3. the tag combined with a sequence
   4. `start`, `end`, `type`, `result`, `marker`

   The tag picks a mode as the sequences do, so it is checked with them, before the dates. Every 400 comes before any read.
2. **Odd values:** `destination_tag=` (empty) is 400 `invalid destination_tag`, as spec §6's "anything else" reads. This differs from the route's empty `type`, `result` and `min_sequence`, which mean no filter. Leading zeros are digits, so `007` is tag 7. A repeated parameter takes its first value (`first`), as every parameter of the route does.
3. **Markers:** a marker is the time list's `[ledger_index, tx_index]` (spec §6). So a marker of the untagged list is accepted by the tagged list, and the reverse, and each continues strictly after its key.
4. **The export count:** with a tag, the up-front count of `@ExportCount` (ticket #16) counts the tag's rows, not the account's.
5. **The schema check:** the syncer needs the table for the `ingest` worker only, because the aggregator neither reads nor writes it. The api has no schema check: before 018, its tagged list answers 500 and every other request answers as before.
6. **No anomaly counter** for a malformed tag: a node cannot serve one, and the spec asks only that nothing throws.
7. **Where the new entries go:** appended after the MPT entries in every list (`Table`, `LedgerRows`, `CHILD_TABLES`, `LEDGER_KEYED_TABLES` and the test lists).

## Review Focus

1. **The parameter written any way a client writes it.** `+1`, `-1`, `1.0`, `1e3`, `0x10`, ` 1`, an empty value, `4294967296` and twenty nines all get 400 `invalid destination_tag` before any read. `007` is tag 7, and `4294967295` is a valid tag with nothing to list. Test: Task 4 `refuses every destination_tag that is not 0 to 4294967295 in digits, before any read`.
2. **An api deployed before migration 018** (the rollout run out of order). The untagged list answers as before, and the tagged one answers 500 `unable to retrieve transactions`. Test: Task 4 `answers without the tag on a database without 018, and 500 with it`.
3. **A ledger written twice before a merge.** Its tag rows are there twice, yet a page lists each transaction once and the pages stay whole. Test: Task 4 `serves a row written twice once` (the second copy goes in an insert of its own, because rows of one key in one insert collapse).
4. **An export of a tagged list.** The up-front count is the tag's 9 rows, not the account's 21, so an export under the cap is not refused. Test: Task 4 `counts an export of a tagged list as the list serves it`.
5. **Markers across the modes.** A sequence marker (three values) is `invalid marker`, and a page's marker continues strictly after its row, ascending and descending. Test: Task 4 `pages in both directions, and takes only a marker of the time list's form`.

---

### Task 1: The rule: `DestinationTagParser`

**Files:**
- Create: `packages/shared/src/parsers/destination-tag.parser.ts`, `packages/shared/src/parsers/destination-tag.parser.spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `ParserTx` and `toParserTx` (`parser.interface.ts`); `FixtureLedgerSource` and `deepFreeze`, used as `state-touches.parser.spec.ts` uses them (`recordedTx(dir, hash)`).
- Produces (for Tasks 2 and 4):
  ```ts
  export const MAX_DESTINATION_TAG = 4_294_967_295;
  export interface ParsedDestinationTag { destination: string; destination_tag: number }
  export class DestinationTagParser { parse(t: ParserTx): ParsedDestinationTag | undefined }   // pure: never writes to t
  ```

The recorded cases. Directories are under `packages/shared/test/fixtures/`.

| Case | Directory, ledger | Hash | Expected |
|---|---|---|---|
| a payment | `xrpl/recorded` 107670360 | `48C09512C3220E6429BB3EC905D48AE75DB5835B86CB76210FA16AD6BC61AC50` | `{ destination: 'rUSyqwqFFYL6RJysH9o5RWNC4b8TiDJsQj', destination_tag: 19593017 }` |
| tag 0 | `xrpl/recorded` 107671538 | `6E887595D351A5A024F50D3FD438C09740C1183A5F30BC60692D1547866B768E` | `{ destination: 'rG2TJM93MdgCNCSMgCxuW47oDFsXK2RyZS', destination_tag: 0 }` |
| a failed payment (`tecPATH_DRY`) | `xrpl/account-state` 93663329 | `851ADEFC847D0490E43FD4BC570D57026998FB7FF0AA061AB32E2E2F0DA7A18B` | `{ destination: 'rH98Tr1c7W4rctaLwEg9xkq64p9E8BWcDM', destination_tag: 1 }` |
| a Batch inner payment (Flags `0x40030000`) | `xrpl/account-state` 107872956 | `3ACCA401077894B79867C792345866944C6928D58FC6AA41BB16223DDC2C76D0` | `{ destination: 'r9ruWAaX3E4EDrMWgs7A7QbcvooMnHkaUd', destination_tag: 0 }` |
| Xahau's `Remit` | `xahau/uritoken` 26689211 | `3D9B20E130D7498E98FB3499BD4C2AC4CCDB3D11FFBFEA8F9B7FB844DDF33426` | `{ destination: 'r9gvUQxtV98nRAM26aknj4h6RXKyXCLMVS', destination_tag: 0 }` |

The synthetic edits start from recorded transactions that have a `Destination` but no tag:
- `escrow_create_timed`: `xrpl/objects`, `BF93E9B72AE372BCEB27781CA58C4ABE7E51EE9F5D254D02B83C92EC1A22AE53`
- `check_create_xrp`: `xrpl/objects`, `DE0C4334780CE8115BCCB7E41371B85D13D284F82F48EFB98BE8D2F894207E0E`
- `channel_create`: `xrpl/objects`, `04BF7DE957E5E2EE8BB67EF00CEB2EFF7A72496FAED3442CA9680E8ECF2EAFB7`
- `account_delete`: `xrpl/account-state`, `8F2DCA944394B29981E24DDD6C46192C404D90F7F5FC4EAB6813B0AFD7751A2D`
- a Xahau `Invoke`: `xahau/objects`, `107488C4A74D3315CC4CA4142F685B4148837CAE62179D27806CF6480D60F6FB`

No recording has a tag on any of these types, nor on `VaultWithdraw`, `LoanBrokerCoverWithdraw`, `ConfidentialMPTSend` or `XChainClaim`.

- [ ] **Step 1: Check the numbers.** Each command and the output it must give:

  | Command | Expected |
  |---|---|
  | `ls packages/shared/schema/` | the highest file is `017_mpt.sql` |
  | `grep -n "^export const PARSER_VERSION\|^export const MPT_PARSER_VERSION" packages/shared/src/clickhouse/rows.ts` | `PARSER_VERSION = 10;` and `MPT_PARSER_VERSION = 10;` |
  | `ls docs/adr` | the highest is `0020-mpt-data.md` |
  | `grep -n "^## Amendment" docs/adr/0010-ripple-v2-wire-compatibility.md \| tail -1` | `## Amendment 11 (2026-10-31): MPTokens` |
  | `grep -oE "^[0-9]+\. " docs/adr/0010-ripple-v2-wire-compatibility.md \| tail -1` | `117.` |
  | `cat packages/shared/schema/*.sql \| grep -c "^CREATE TABLE IF NOT EXISTS"` | `85` |
  | `ruby -ryaml -e 'puts YAML.load_file("docs/openapi.yaml")["paths"].size'` | `105` |

  If anything else comes back, apply the rule of Global Constraints.
- [ ] **Step 2: Write the failing tests** in `destination-tag.parser.spec.ts`. Every transaction is deep-frozen, and a synthetic one is `deepFreeze({ ...t, tx: { ...t.tx, <edit> } })`.
  - `it.each` over the five recorded cases, `it('reads the tag of %s')`: `parser.parse(recordedTx(dir, hash))` `toEqual` the expected value.
  - `it('gives nothing for recorded transactions without a tag')`: the five sources of the edits each give `undefined`.
  - `it('reads the tag whatever the type (synthetic: each source above with DestinationTag 7 added, and the recorded payment with TransactionType "FutureType")')`: each gives `{ destination: <its Destination>, destination_tag: 7 }` (the renamed payment gives its own tag).
  - `it('reads the highest tag (synthetic: the recorded payment with DestinationTag 4294967295)')`.
  - `it('gives nothing, and does not throw, for a tag or a destination that is not one (synthetic: the recorded payment edited)')`:
    - `DestinationTag` set to `4294967296`, `-1`, `1.5`, `'5'`, `null`, `true` or `{}` gives `undefined`;
    - `Destination` removed, `5` or `null` gives `undefined`;
    - each call passes `expect(() => parser.parse(t)).not.toThrow()`.
- [ ] **Step 3: Run the tests and watch them fail.** `pnpm --filter @gatehub/data-api-shared test destination-tag` → FAIL: `Cannot find module './destination-tag.parser'`.
- [ ] **Step 4: Implement `DestinationTagParser.parse`** with `typeof tx.Destination === 'string'`, `Number.isInteger(tx.DestinationTag)` and `0 <= tag <= MAX_DESTINATION_TAG`. Export the module from `index.ts`.
- [ ] **Step 5: Run the tests and watch them pass.** The same command → PASS, and `pnpm --filter @gatehub/data-api-shared build` exits 0.
- [ ] **Step 6: Commit.** `git add packages/shared/src/parsers/destination-tag.parser.ts packages/shared/src/parsers/destination-tag.parser.spec.ts packages/shared/src/index.ts` — `feat(shared): read a transaction's destination and destination tag`.

---

### Task 2: Migration 018, its rows and parser version 11

**Files:**
- Create: `packages/shared/schema/018_destination_tags.sql`
- Modify:
  - `packages/shared/src/clickhouse/tables.ts`: `Table.AccountTxByDestinationTag`, with a comment as the MPT block has
  - `packages/shared/src/clickhouse/rows.ts`: the row type, `DESTINATION_TAG_PARSER_VERSION`, `PARSER_VERSION`, item 11 of the version list and the gates named in its last paragraph
  - `packages/shared/src/ingest/build-rows.ts`: `LedgerRows.accountTxByDestinationTag` and its doc line, its `[]` in `buildRows`, the `CHILD_TABLES` entry and comment, and the row itself
  - `packages/shared/src/ingest/ingest-state.ts`: `LEDGER_KEYED_TABLES` (P7) and its comment
  - `packages/shared/src/ingest/ingest-state.spec.ts`
  - `packages/shared/src/ingest/build-rows.spec.ts`: `ROW_KEY`, the list of `every row has the columns of its table, in the order of the DDL`, the `CHILD_TABLES` test and its title, and the four tests that pin version 10 (lines 1524, 1936, 2428, 2945)
  - `packages/shared/src/ingest/__snapshots__/build-rows.spec.ts.snap`
  - `packages/shared/test/sample-rows.ts`: `TableRows` and `SAMPLE_ROWS`
  - `packages/shared/test/migrate.e2e-spec.ts`: `SHAPES`, `DEDUP_TABLES` and a describe for 018
  - `packages/shared/test/ledger-writer.e2e-spec.ts`
  - `docs/data-model.md`
- Unchanged, but must pass:
  - `packages/shared/src/clickhouse/schema.spec.ts`
  - `packages/shared/test/build-rows.e2e-spec.ts`: its lists are per family, and its scenarios insert every `CHILD_TABLES` array
  - `load/seed.js`: it seeds the load tests, which ask for no tag

**Interfaces:**
- Consumes: Task 1's `DestinationTagParser`.
- Produces (for Tasks 3 to 5):
  ```ts
  Table.AccountTxByDestinationTag = 'account_tx_by_destination_tag'
  export interface AccountTxByDestinationTagRow { account: string; destination_tag: number; ledger_index: number; tx_index: number;
    tx_type: string; result: string; close_time: UnixSeconds }
  export const DESTINATION_TAG_PARSER_VERSION = 11;   // readers gate on it, never on PARSER_VERSION
  export const PARSER_VERSION = 11;
  LedgerRows.accountTxByDestinationTag: AccountTxByDestinationTagRow[]   // CHILD_TABLES: [Table.AccountTxByDestinationTag, 'accountTxByDestinationTag']
  LEDGER_KEYED_TABLES: { table: Table.AccountTxByDestinationTag, partitionSize: P7 }
  ```

**The migration** is the spec's DDL exactly, as one `CREATE TABLE IF NOT EXISTS`. Above it goes a header comment in the form of 017's, saying:
- that ingest writes the table from parser version 11;
- that recovery and `--reprocess` delete its rows with their ledger;
- that it must exist before the syncer of parser version 11 and before the api;
- the runner's constraints.

No comment line may end with a semicolon.

**The row:** in the loop of `buildRows`, right after the push to `accountTxBySequence`, when `parse(t)` gives a value, push:

`{ account: destination, destination_tag, ledger_index: header.ledger_index, tx_index: txIndex, tx_type: txType, result, close_time: closeTime }`

- [ ] **Step 1: Write the failing tests.**
  - `build-rows.spec.ts`, `describe('account_tx_by_destination_tag (parser version 11)')`:
    - `it('writes the 25 tagged payments of the ripple-mock ledgers, under 8 destinations and tags')`. The (destination, tag, rows) groups:

      | Destination | Tag | Rows |
      |---|---|---|
      | `rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj` | 191150 | 1 |
      | `rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj` | 223051 | 8 |
      | `rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj` | 225881 | 9 |
      | `rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj` | 219151 | 3 |
      | `rfKeuNcxyuKRK8QH5VmcxKfsVgPdSxwGpj` | 3087927 | 1 |
      | `rfKeuNcxyuKRK8QH5VmcxKfsVgPdSxwGpj` | 3087932 | 1 |
      | `rhxULAn1xW9T4V2u67FX9pQjSz4Tay2zjZ` | 761732776 | 1 |
      | `rGmFH7pyrKs7E84MkGmgKc1gnsx6ZbWDwB` | 18547409 | 1 |

      The row of ledger 11119610, transaction 2, equals `{ account: 'rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj', destination_tag: 191150, ledger_index: 11119610, tx_index: 2, tx_type: 'Payment', result: 'tesSUCCESS', close_time: <rows.ledger.close_time> }`.
    - `it('writes the failed and the Batch inner transactions of the recorded account-state ledgers')`. It uses a new set `ACCOUNT_STATE_SET` (`xrpl/account-state`, `XRPL`, written as `NFT_SET` is).
      - Ledger 93663334 has four rows `{ account: 'rBUZp2fS6WCjURm5WVJGzevmXafJ23pk19', destination_tag: 104, result: 'tecPATH_DRY' }` at transactions 113 to 116.
      - Ledger 107872956 has `{ account: 'r9ruWAaX3E4EDrMWgs7A7QbcvooMnHkaUd', destination_tag: 0, tx_index: 240 }`.
    - `it('writes the Remit of Xahau')`: `URITOKEN_SET`, ledger 26689211, has `{ account: 'r9gvUQxtV98nRAM26aknj4h6RXKyXCLMVS', destination_tag: 0, tx_index: 0, tx_type: 'Remit' }`.
    - `it('builds the rest of a ledger and writes no row for a tag that is not one (synthetic: sampleLedger with DestinationTag 4294967296 and "5" on two of its transactions)')`.
    - `it('writes at most one row per transaction: (account, destination_tag, ledger_index, tx_index) is unique')`, over every set of the file.
    - `ROW_KEY` and the DDL-order list gain the table. The `CHILD_TABLES` test lists it, and its title ends `…, the 5 MPT ledger tables and the destination tag index`.
    - The four version tests change:
      - `PARSER_VERSION` and `DESTINATION_TAG_PARSER_VERSION` are 11, and `MPT_PARSER_VERSION` stays 10;
      - every built ledger has `parser_version` 11;
      - the MPT test says the MPT ledgers are at or above `MPT_PARSER_VERSION`.
  - `ingest-state.spec.ts`: `it('lists account_tx_by_destination_tag by ten million, as account_tx_by_sequence')`.
  - `migrate.e2e-spec.ts`:
    - `SHAPES` gains `[Table.AccountTxByDestinationTag]: { engine: 'ReplacingMergeTree', partition: P7, order: 'account, destination_tag, ledger_index, tx_index' }`.
    - `DEDUP_TABLES` gains the table.
    - `SAMPLE_ROWS` gains a row with `destination_tag: 0`, so the round trip and the "exactly the tables of the Table enum" test cover it.
    - `describe('018_destination_tags.sql')`:
      - `it('is one CREATE TABLE IF NOT EXISTS and nothing else')`
      - `it('applies 018 to a database migrated before it, and then nothing')`
      - `it('applies 018 twice: the statement can simply be run again, and a row stays')`
      - `it('gives account_tx_by_destination_tag the columns of the spec, in order')`: the names and types of Global Constraints
      - `it('holds the tags 0 and 4294967295')`
  - `ledger-writer.e2e-spec.ts`:
    - `BUILT` holds 25 `accountTxByDestinationTag` rows. Because the table is not a seeded table, the generic tests of write, recovery and delete reach it through `CHILD_TABLES` and `LEDGER_KEYED_TABLES`.
    - In `does not touch partitions at or below the checkpoint partition`, `partitionsOf(Table.AccountTxByDestinationTag)` is `[1, 2]`: the tagged payments above the 40th ledger are in ledgers 11616399 to 11618225 and in 29709909.
- [ ] **Step 2: Run the tests and watch them fail.**
  - `pnpm --filter @gatehub/data-api-shared test build-rows ingest-state` → FAIL: `Property 'AccountTxByDestinationTag' does not exist on type 'typeof Table'`.
  - `pnpm --filter @gatehub/data-api-shared test:e2e migrate` → FAIL for the same reason.
- [ ] **Step 3: Implement** the migration, the enum entry, the row type and constants, the list entries, the row, the sample row and `docs/data-model.md`. The doc changes:
  - the count: 85 → 86 tables, ledger-derived (40) → (41), at lines 23, 27 and 84
  - "39 of the 40" → "40 of the 41" (line 786)
  - a section `### account_tx_by_destination_tag (P7, ORDER BY (account, destination_tag, ledger_index, tx_index))`
  - the table in the relationships diagram, beside `account_tx_by_sequence`
  - 018 in the migration list
  - version 11 where the parser versions are listed
- [ ] **Step 4: Update the snapshots of the bump only.** Run `pnpm --filter @gatehub/data-api-shared test build-rows -u`, then read `git diff packages/shared/src/ingest/__snapshots__/`. Nothing may change but `"parser_version": 10` → `11` and the new `"accountTxByDestinationTag"` arrays.
- [ ] **Step 5: Run the tests and watch them pass.** Each of these → PASS:
  - `pnpm --filter @gatehub/data-api-shared test`
  - `pnpm --filter @gatehub/data-api-shared build`
  - `pnpm --filter @gatehub/data-api-shared test:e2e migrate ledger-writer build-rows parser-coverage`
- [ ] **Step 6: Commit.** `git add packages/shared/schema/018_destination_tags.sql packages/shared/src/clickhouse/tables.ts packages/shared/src/clickhouse/rows.ts packages/shared/src/ingest/build-rows.ts packages/shared/src/ingest/ingest-state.ts packages/shared/src/ingest/ingest-state.spec.ts packages/shared/src/ingest/build-rows.spec.ts packages/shared/src/ingest/__snapshots__/build-rows.spec.ts.snap packages/shared/test/sample-rows.ts packages/shared/test/migrate.e2e-spec.ts packages/shared/test/ledger-writer.e2e-spec.ts docs/data-model.md` — `feat(shared): migration 018 and the destination tag rows; parser version 11`.

---

### Task 3: The syncer: the boot check and a reprocess

**Files:**
- Modify:
  - `apps/syncer/src/core/schema-check.ts`
  - `apps/syncer/src/core/schema-check.spec.ts`
  - `apps/syncer/src/core/syncer-core.module.ts`: the call after `assertMptSchema`, and the doc comment of `SCHEMA_READY`
  - `apps/syncer/test/app.e2e-spec.ts`
  - `apps/syncer/test/range-ingest.e2e-spec.ts`
  - `docs/syncer.md`: the tables the parser writes (lines 91 and 101) and parser version 11; the boot check
  - `docs/troubleshooting.md`: a section `### Syncer refuses to boot: lacks the schema of 018_destination_tags.sql`
- Unchanged, but must pass:
  - the 014, 015 and 017 cases of `app.e2e-spec.ts`: their databases lack 018 too, but the earlier checks refuse first, and their aggregator boots need no 018
  - `apps/syncer/test/live-runner.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2's `Table.AccountTxByDestinationTag` and `LedgerRows.accountTxByDestinationTag`; `assertTablesOf` and `SchemaNeeds`, used as `assertMptSchema` uses them.
- Produces:
  ```ts
  export const DESTINATION_TAG_MIGRATION = '018_destination_tags.sql';
  // needs: 'ingest' → { tables: [Table.AccountTxByDestinationTag], does: 'writes' }; no other worker
  export async function assertDestinationTagSchema(ch: Pick<ClickHouseService, 'query'>, enabled: ReadonlySet<WorkerName>,
    database: string, logger: { warn(message: string): void }): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests.**
  - `schema-check.spec.ts`, `describe('assertDestinationTagSchema')`:
    - `it('checks nothing when the ingest worker is not enabled, the aggregator alone included')`
    - `it('passes a database with account_tx_by_destination_tag for the ingest, reading system.tables with bound values')`: the params are `{ tables: [Table.AccountTxByDestinationTag] }`
    - `it('fails the boot of the ingest worker on a database without 018, naming the migration and the table, on every network')`: for each of `xrpl`, `xrpl_testnet`, `xahau` and `xahau_testnet`, the error contains:
      - `018_destination_tags.sql`
      - `(table account_tx_by_destination_tag)`
      - `the ingest worker writes`
      - `database "<db>"`
      - `apply the migrations`
    - `it('does not fail the boot when the check cannot be made, and says so')`
  - `app.e2e-spec.ts`, `it('fails the boot, naming 018_destination_tags.sql and its table, when the ingest worker runs on a database of 001, 014, 015 and 017')`:
    - the refusal matches `/lacks the schema of 018_destination_tags\.sql \(table account_tx_by_destination_tag\), which the ingest worker writes/` and does not contain `017_mpt.sql`;
    - `GH_WORKERS: 'aggregator'` boots on the same database;
    - the migrations with 018 added give the table.
  - `range-ingest.e2e-spec.ts`, `describe('destination tag rows (parser version 11)')`, over `FIXTURES` (the ripple-mock ledgers):
    - `it('writes the 25 tag rows of the ripple-mock ledgers')`: the count equals the sum of `buildLedgerRows(raw, ctx).accountTxByDestinationTag.length`, which is 25, and `count()` equals `uniqExact(account, destination_tag, ledger_index, tx_index)`.
    - `it('--reprocess replaces the tag rows of its range: the same 25, each once, and a row the parser does not write is gone')`. Before the reprocess, insert a stale row (in its own insert) of `rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj`, tag 1, ledger 11616401, transaction 0. After `--reprocess` of `FIXTURE_FROM` to `FIXTURE_TO`:
      - the stale row is gone;
      - there are 25 rows, each key once.
    - `it('--reprocess gives ledgers written without tag rows (parser version 10) their rows')`: delete every row of the table, reprocess, and the 25 rows are back.
- [ ] **Step 2: Run the tests and watch them fail.** After `pnpm --filter @gatehub/data-api-shared build`, run `pnpm --filter @gatehub/data-syncer test schema-check` → FAIL: `assertDestinationTagSchema` is not exported.
- [ ] **Step 3: Implement the check, wire it into the module, and write the two docs.**
- [ ] **Step 4: Run the tests and watch them pass.** `pnpm --filter @gatehub/data-syncer test` and `pnpm --filter @gatehub/data-syncer test:e2e app range-ingest` → PASS.
- [ ] **Step 5: Commit.** `git add apps/syncer/src/core/schema-check.ts apps/syncer/src/core/schema-check.spec.ts apps/syncer/src/core/syncer-core.module.ts apps/syncer/test/app.e2e-spec.ts apps/syncer/test/range-ingest.e2e-spec.ts docs/syncer.md docs/troubleshooting.md` — `feat(syncer): refuse to boot the ingest without migration 018`.

---

### Task 4: The route: `destination_tag` on the account transactions

**Files:**
- Create: `apps/api/test/account-transactions-destination-tag.e2e-spec.ts`
- Modify:
  - `apps/api/src/common/coverage-features.ts`: the `destination_tags` entry and the registry's comment
  - `apps/api/src/common/coverage-features.spec.ts`
  - `apps/api/src/accounts/account-transactions.service.ts`
  - `apps/api/src/accounts/account-transactions.controller.ts`: the parameter and its checks, the tagged answer, `@ApiQuery`, a sentence in the description, and `exportRows`
- Unchanged, but must pass: `apps/api/test/account-transactions.e2e-spec.ts`, `exports.e2e-spec.ts`, `export-limits.e2e-spec.ts`.

**Interfaces:**
- Consumes:
  - Task 1's `MAX_DESTINATION_TAG`
  - Task 2's `Table.AccountTxByDestinationTag` and `DESTINATION_TAG_PARSER_VERSION`
  - `FeatureCoverageService.coverage` and `Coverage` (a global module: inject it into the service, as `AccountMptService` does)
  - the service's private `timeWindow` and `page`, `TIME_KEYS`, `readDistinctPage`, `keysetClause`, `decodeMarker`, `paginate` and `columnsOf`
- Produces (for Tasks 5 and 6):
  ```ts
  // account-transactions.service.ts
  export interface DestinationTagQuery extends TimeQuery { destinationTag: number }
  export interface DestinationTagPage extends TransactionsPage { coverage: Coverage }
  listByDestinationTag(q: DestinationTagQuery): Promise<DestinationTagPage>;              // decodes the marker before any read
  countByDestinationTag(q: TimeWindow & { destinationTag: number }): Promise<number>;
  // account-transactions.controller.ts
  export const DESTINATION_TAG_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'transactions'] as const;
  // coverage-features.ts
  destination_tags: { parserVersion: DESTINATION_TAG_PARSER_VERSION, startOf: () => ({ kind: 'first_ledger' }) }
  ```

**The read** is `readDistinctPage` over `account_tx_by_destination_tag`:
- `columns`: `ledger_index, tx_index`
- `where`: the conditions of `timeWindow` (`account`, the ledger range, `tx_type` and `result`, all of them columns of the new table), plus `destination_tag = {destination_tag:UInt32}` and the keyset of `TIME_KEYS`
- `orderBy`: `account, destination_tag, ledger_index, tx_index`
- `unique`: `ledger_index, tx_index`
- `limit`: `limit + 1`

Then `paginate` and `page`, as `listByTime` does, with the coverage read beside the page. The count is `count()` of `DISTINCT ledger_index, tx_index` under the same conditions. `listByTime`, `listBySequence` and `countByTime` are not edited.

`exportRows`, given a tag, checks it as the list does (a 4xx counts as "not known") and returns `countByDestinationTag`.

**The world** is the seed `ripple-mock`:
- `ACCOUNT = 'rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj'`: 21 transactions, every one a payment it received with a tag.
- `TAG = 225881`, with these 9 keys, oldest first: `11616401:0, 11616411:0, 11616411:1, 11616412:0, 11616412:1, 11616412:2, 11616413:2, 11616413:3, 11616413:5`. Ledgers 11616411 and 11616412 both closed at 2015-02-09T18:15:20Z.
- `SENT_WITH_TAG = 'r42nKAR9UfZJu6gLLtrVyPvTMLZfpCDdhR'`: it sent 11616411:0 with tag 225881 and received nothing with a tag.

- [ ] **Step 1: Write the failing tests.**
  - `coverage-features.spec.ts`: `it('destination_tags: parser version 11, from the first ledger on every network')`. `parserVersion` is `DESTINATION_TAG_PARSER_VERSION`, which is 11, and `startsOf('destination_tags')` is `first_ledger` for all four profiles.
  - The new e2e file, main harness (`ripple-mock`):
    - `it('lists the 9 transactions sent to the account under the tag, oldest first, each the object of the list without the tag')`:
      - the 9 keys above, in order;
      - each item `toEqual` the untagged list's item of the same key;
      - `Object.keys(body)` is `DESTINATION_TAG_BODY_KEYS` without `marker`;
      - `coverage` is `{ from_ledger_index: <the seed's lowest ledger>, complete: false }`.
    - `it('pages in both directions, and takes only a marker of the time list's form')` (Review Focus 5):
      - `limit=2` pages, ascending and with `descending=true`, concatenate to the unpaged list and to its reverse;
      - each marker decodes to the `[ledger_index, tx_index]` of its page's last row, and the `Link` header carries it;
      - a marker of `?min_sequence=0` (three values) gets 400 `invalid marker`.
    - `it('filters by start and end, type and result')`:

      | Query | Rows |
      |---|---|
      | `start=2015-02-09T18:15:20&end=2015-02-09T18:15:20` | the 5 of ledgers 11616411 and 11616412 |
      | `start=2015-02-09T18:15:21` | the 3 of ledger 11616413 |
      | `type=Payment` | 9 |
      | `type=OfferCreate` | 0 |
      | `result=tesSUCCESS` | 9 |
      | `result=tecPATH_DRY` | 0 |
      | `start=2030-01-01` | 0, and `coverage` is still there |
    - `it('serves binary=true and format=csv as the list without the tag serves those rows')`:
      - each binary item equals the untagged binary item of its key;
      - the CSV's header equals the untagged CSV's header, and its 9 rows equal the untagged CSV's rows of the 9 hashes, in order;
      - `Content-Disposition` is `rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj - transactions.csv` (`csvDisposition`);
      - the text has no `coverage`.
    - `it('tag 0 is a tag: nothing to list for this account; and an account that sent with the tag received none')`:
      - `destination_tag=0` gives count 0, with `coverage`;
      - `SENT_WITH_TAG` with `destination_tag=225881` gives count 0, while its untagged list holds 11616411:0.
    - `it('refuses every destination_tag that is not 0 to 4294967295 in digits, before any read')` (Review Focus 1):
      - each of `+1`, `-1`, `1.0`, `1e3`, `0x10`, `%201`, the empty value, `abc`, `4294967296` and `99999999999999999999` gets 400 `invalid destination_tag`, and `h.ch.query` is not called;
      - `007` gets the answer of `7`;
      - `4294967295` gets 200 and count 0.
    - `it('refuses destination_tag with min_sequence or max_sequence, in the order of the checks')`. None of these reads anything:

      | Query | Answer |
      |---|---|
      | `destination_tag=1&min_sequence=1` | 400 `destination_tag cannot be combined with min_sequence or max_sequence` |
      | `destination_tag=1&max_sequence=1` | the same 400 |
      | `destination_tag=1&min_sequence=` | 200 (an empty sequence is none) |
      | `destination_tag=x&min_sequence=y` | 400 `invalid min_sequence` |
      | `destination_tag=x&min_sequence=1` | 400 `invalid destination_tag` |
      | `destination_tag=x&start=bad` | 400 `invalid destination_tag` |
      | `destination_tag=1&start=bad` | 400 `invalid start date format` |
      | `destination_tag=1&type=Nope` | 400 `invalid transaction type` |
      | `destination_tag=1&marker=%25%25` | 400 `invalid marker` |
    - `it('serves a row written twice once')` (Review Focus 3): insert the 9 rows of the tag again, in a second insert. The list is the same 9, and its `limit=2` pages still concatenate to them.
    - `it('counts an export of a tagged list as the list serves it')` (Review Focus 4), on `h.app.get(AccountTransactionsController).exportRows(ACCOUNT, …)`:
      - `{ destination_tag: '225881' }` gives 9;
      - with no tag it gives 21;
      - `{ destination_tag: 'x' }` rejects with a 400.
    - `it('reads one page of account_tx_by_destination_tag and the transactions by key')`: one `isPageRead` statement on the table, then the read of `transactions` that the time list makes.
    - `it('without the tag reads and answers as before')`. For the time list, the sequence list (`SENT_WITH_TAG?min_sequence=0`) and the CSV:
      - no statement names `account_tx_by_destination_tag` or reads `parser_version`;
      - the keys are `result, count, marker?, transactions`.
  - Coverage harness (`ripple-mock`): `it('says complete once the first ledger of the network is of parser version 11, and not once a ledger above it is older')`. Clear the cache between reads with `/v2/test-cache/clear`, as `tokens.e2e-spec.ts` does. Step by step:
    1. the answer starts at `{ from_ledger_index: <lowest>, complete: false }`;
    2. a `ledgers` row at 32,570 with `parser_version: DESTINATION_TAG_PARSER_VERSION` gives `{ from_ledger_index: 32570, complete: true }`;
    3. a row at 90,000,000 of version 10 then gives `{ from_ledger_index: 90000001, complete: false }`.
  - `xrpl-account-state` harness: `it('lists failed transactions and Batch inner transactions')`:
    - `rBUZp2fS6WCjURm5WVJGzevmXafJ23pk19` with tag 104 lists 93663334:113 to 93663334:116;
    - `result=tecPATH_DRY` gives the same 4, and `result=tesSUCCESS` gives 0;
    - `r9ruWAaX3E4EDrMWgs7A7QbcvooMnHkaUd` with tag 0 includes 107872956:240.
  - `xahau-uritoken` harness: `it('lists a Remit with tag 0 on Xahau, filters it by type, and states its coverage')`:
    - `r9gvUQxtV98nRAM26aknj4h6RXKyXCLMVS` with tag 0 lists 26689211:0, a `Remit`;
    - `type=Remit` gives 1, and `type=Payment` gives 0;
    - coverage says `complete: false`, and after a `ledgers` row at ledger 1 of version 11 it is `{ from_ledger_index: 1, complete: true }`.
  - Harness before 018 (`ripple-mock`, then `DROP TABLE account_tx_by_destination_tag`): `it('answers without the tag on a database without 018, and 500 with it')` (Review Focus 2):
    - the untagged list answers 200 with the 21;
    - the tagged one answers 500 `{ result: 'error', message: 'unable to retrieve transactions' }`.
- [ ] **Step 2: Run the tests and watch them fail.** After `pnpm --filter @gatehub/data-api-shared build`:
  - `pnpm --filter @gatehub/data-api-service test coverage-features` → FAIL: `destination_tags` is undefined.
  - `pnpm --filter @gatehub/data-api-service test:e2e account-transactions-destination-tag` → FAIL: the tagged request answers the account's 21 transactions without `coverage`.
- [ ] **Step 3: Implement** the coverage entry, the two service methods, and the controller's parameter, checks, answer, `@ApiQuery({ name: 'destination_tag', required: false, type: Number, … })` and `exportRows`.
- [ ] **Step 4: Run the tests and watch them pass.** `pnpm --filter @gatehub/data-api-service test` and `pnpm --filter @gatehub/data-api-service test:e2e account-transactions exports export-limits` → PASS. The pattern `account-transactions` matches both files.
- [ ] **Step 5: Commit.** `git add apps/api/src/common/coverage-features.ts apps/api/src/common/coverage-features.spec.ts apps/api/src/accounts/account-transactions.service.ts apps/api/src/accounts/account-transactions.controller.ts apps/api/test/account-transactions-destination-tag.e2e-spec.ts` — `feat(api): destination_tag on the account transactions`.

---

### Task 5: The read bound

**Files:**
- Modify: `apps/api/test/paged-reads.e2e-spec.ts`, which gains a describe of its own

**Interfaces:**
- Consumes:
  - Task 4's route and `AccountTransactionsController.exportRows`
  - `insertBulk`, `BULK_BASES`, `readsOf` and `markerOf` (`support/read-rows.ts`)
  - `served` and `primaryKeys` (`support/amm.ts`)
  - `explain`, `innerRead`, `expectBoundedInOrderRead` and `isPageRead` (`support/plans.ts`)

**The bulk** has one part per base; `insertBulk` stops the merges. Every template is a row of the seed.

| Rows | Tag | Per part | Keys |
|---|---|---|---|
| the tag's | `TAG = 4_000_000_000` | 100 | `(base + n × 250, tx_index 4)` |
| a tag before it | `TAG − 1` | 100,000 | `bulkLedger(base)`, `BULK_TX_INDEX` (0 to 3) |
| a tag after it | `TAG + 1` | 100,000 | `bulkLedger(base)`, `toUInt32(5 + n.number % 4)` |
| `transactions` | none | 100 | the tag's 400 keys, copies of one ripple-mock transaction, so that pages are whole |

All the tagged rows belong to Task 4's `ACCOUNT`. The tx-index ranges never overlap, so no two rows share a key even without the tag in it.

The bound (spec §7: its own rows plus 2 granules per part): `GRANULE = 8192`, `PARTS = 4`, `READ_BOUND = 400 + 2 × GRANULE × PARTS`.

- [ ] **Step 1: Write the tests** in `describe('the transactions of a destination tag read the rows of the tag, not the other tags of the account (read_rows over a bulk of four parts)')`:
  - `it('the seed is as assumed: 400 rows of the tag in four parts, 800,421 rows of the account')`.
  - `describe.each([false, true])('descending=%s')`:
    - `it.each([['the first page', undefined], ['a page that starts inside the bulk', [BULK_BASES[1] + 12_500, 4]]])('a page of 100 (%s) reads at most the rows of the tag and two granules a part, and is whole')`: every read of the table is at most `READ_BOUND`, and the page has 100 transactions and a marker. The page is 100, not 200, because from the middle of the second part only 150 rows of the tag lie behind it, descending.
    - `it('the page read is read in the order of the key, stops after its rows, and narrows the key to the account and the tag')`: there is one `isPageRead` statement and it passes `expectBoundedInOrderRead`; its `EXPLAIN indexes = 1` shows a primary key on `account`, `destination_tag` and `ledger_index`.
  - `it('the up-front count of an export reads the rows of the tag')`: the count is 400, and every read is at most `READ_BOUND`.
  - `it('with the tag out of the key the same page reads the rows of the account: the bound is the key at work (control)')`:
    1. Create `account_tx_by_destination_tag_mutant`, with the same columns, partition and settings but `ORDER BY (account, ledger_index, tx_index)`.
    2. Stop its merges and fill it part by part: one `INSERT … SELECT` per bulk base, and one for the seed's rows.
    3. Swap it in with `EXCHANGE TABLES`.
    4. The first page of 100 now reads more than `READ_BOUND` (at least 200,000 rows: the whole first part, before the 101st row of the tag).
    5. Swap it back, and the same page is within the bound again.
- [ ] **Step 2: Run the tests.** `pnpm --filter @gatehub/data-api-service test:e2e paged-reads -t 'destination tag'` → PASS, the control included. If a bounded test fails, fix Task 4's read, never the bound.
- [ ] **Step 3: Watch a mutation fail.** In `listByDestinationTag`, take `destination_tag` out of `orderBy` and run the same command: the in-order test and the bounded pages fail. Restore it; `git diff apps/api/src` shows nothing.
- [ ] **Step 4: Commit.** `git add apps/api/test/paged-reads.e2e-spec.ts` — `test(api): a tagged page reads the rows of its tag, not the account's`.

---

### Task 6: Reference, ADRs and the OpenAPI file

**Files:**
- Create: `docs/adr/0021-transactions-by-destination-tag.md`
- Modify:
  - `docs/api-reference.md`:
    - § `GET /v2/accounts/{address}/transactions`: the parameter's row, the tagged answer with the line ``Keys of the answer with `destination_tag`, in order: `result, coverage, count, marker?, transactions`.``, the two errors and an example
    - § Coverage: the route, and `destination_tags` among the features as old as the network, with parser version 11
    - § Compatibility: the extra
  - `docs/adr/0010-ripple-v2-wire-compatibility.md`: "Amended twelve times" in its status line, and Amendment 12
  - `docs/adr/README.md`: the row for 0021
  - `docs/openapi.yaml`: regenerated

**Interfaces:**
- Consumes: Task 4's `DESTINATION_TAG_BODY_KEYS` and the plan decisions.

**The example** is abbreviated in the style of `GET /v2/transactions`, with values from the ripple-mock seed: `GET /v2/accounts/rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj/transactions?destination_tag=225881&limit=2` → `{ "result": "success", "coverage": { "from_ledger_index": …, "complete": false }, "count": 2, "marker": "…", "transactions": [ {hash, ledger_index, date, tx, meta}, … ] }`. It is not a checked example: `api-reference-examples.e2e-spec.ts` checks the D2 and MPT worlds only, and Task 4 pins the key order.

**ADR-0010, Amendment 12 (2026-11-06): transactions by destination tag.** The items:
- 118: `destination_tag` as an extra. It lists the transactions whose own `Destination` is the account and whose own `DestinationTag` is the tag, of any type and result, and tag 0 is a tag. It does not list the transactions that finish a tagged object (`EscrowFinish`, `CheckCash` and `PaymentChannelClaim` carry no tag; the create is listed), nor those the account sent.
- 119: The shape. `coverage` comes after `result` (the feature `destination_tags`, parser version 11, from the first ledger, never complete on a testnet) and is not in the CSV. `binary`, the CSV and the time list's marker work as on the list without the tag.
- 120: The messages and checks. 400 `invalid destination_tag` departs from `/v2/accounts/{address}/payments`, where text that is not a tag matches nothing: that rule copies Ripple's, and this parameter is ours. 400 `destination_tag cannot be combined with min_sequence or max_sequence`. The order of plan decision 1, and an empty value is invalid.
- 121: Kept: without the parameter the route is the original's.

**ADR-0021** has three short parts:
- **Context:** a deposit address tells its senders apart by tag. `account_transactions` is sorted by account and ledger, so a filter on the tag would read the wallet's whole history.
- **Decision:**
  - a ledger table keyed `(account, destination_tag, ledger_index, tx_index)`, ledger-keyed and P7 (migration 018);
  - the rule on the fields, from parser version 11;
  - the page fetches the transactions as the time list does;
  - the coverage feature `destination_tags`, from the first ledger;
  - the two 400s;
  - set aside: a column with a skip index on `account_transactions`, and filtering the stored JSON (spec §4).
- **Consequences:**
  - one row per tagged transaction;
  - `complete` only after the whole-history reprocess;
  - testnets are never complete;
  - an `EscrowFinish` or `CheckCash` is not listed under the tag of what it finishes.

- [ ] **Step 1: Write the reference changes and the two ADRs.**
- [ ] **Step 2: Regenerate `docs/openapi.yaml`** with the commands of `docs/development.md` §8, keeping the header comment of the file. Those commands boot the api against the unreachable `http://127.0.0.1:1`.
- [ ] **Step 3: Check the file.** Compare it with the committed one, by parsed paths:

  ```bash
  ruby -ryaml -e 'a = YAML.load(`git show HEAD:docs/openapi.yaml`); b = YAML.load_file("docs/openapi.yaml")
    p b["paths"].size, a["paths"].keys - b["paths"].keys, b["paths"].keys - a["paths"].keys,
      a["paths"].keys.select { |k| a["paths"][k] != b["paths"][k] },
      b["paths"]["/v2/accounts/{address}/transactions"]["get"]["parameters"].any? { |x| x["name"] == "destination_tag" }'
  ```

  Expected: `105`, `[]`, `[]`, `["/v2/accounts/{address}/transactions"]`, `true`.
- [ ] **Step 4: Run the checks.** `pnpm build`, `pnpm --filter @gatehub/data-api-service test` and `pnpm --filter @gatehub/data-api-service test:e2e api-reference-examples` → PASS.
- [ ] **Step 5: Commit.** `git add docs/api-reference.md docs/adr/0021-transactions-by-destination-tag.md docs/adr/0010-ripple-v2-wire-compatibility.md docs/adr/README.md docs/openapi.yaml` — `docs: the destination_tag reference, ADR-0021, ADR-0010 Amendment 12 and the OpenAPI file`.

---

### Task 7: Rollout docs, counts and the whole suite

**Files:**
- Modify:
  - `docs/backfill.md`: item 11 of the parser versions (around line 136), and a section `### Destination tag re-ingest` before `### Public nodes and rate limits`
  - `docs/operations.md`:
    - a paragraph on 018 after 017's (line 116)
    - "39 of the 40" → "40 of the 41", with `account_tx_by_destination_tag` in the P7 loop of the retention block (lines 362 to 373)
    - a rollout section
  - `docs/clickhouse.md`: 85 → 86 (line 12), 40 → 41 (lines 169, 198 and 208) and its table lists
  - `docs/deployment.md`: the schema migrations list (018 sets the order migrate, then syncer, then api)
  - `docs/README.md`: 85 → 86, with the migration's one table (line 22); 40 → 41 (line 50)
  - `docs/architecture.md`: 40 → 41 (line 69); 85 → 86 (line 242)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Find every count.** `grep -rnE "\b85\b|\b40\b|39 of the 40" docs/*.md | grep -iE "table|ledger-derived|partition"`. Change each hit, and look at `docs/data-model.md` again (Task 2 changed it).
- [ ] **Step 2: Write the backfill section** (spec §10). It says:
  - which ledgers need it: every ledger from the network's first (32,570 on the XRP Ledger, 1 on Xahau);
  - that the program's whole-history reprocess covers it if it runs after parser version 11;
  - how to run a range alone: `range-ingest --from <first> --to <checkpoint> --reprocess`;
  - that until then `complete` is false and older ledgers have no rows;
  - that testnets are never complete.

  It ends with the checks `SELECT parser_version, count() FROM xrpl.ledgers GROUP BY parser_version ORDER BY parser_version;` (every ledger at 11 or later) and `SELECT count() FROM xrpl.account_tx_by_destination_tag;`.
- [ ] **Step 3: Write the operations rollout** (spec §10):
  1. Apply `018_destination_tags.sql` on each network's database (`dc run --rm migrate-xrpl`, and the same for each network).
  2. Deploy the syncer (parser version 11) and the api together.
  3. Reprocess.

  Add that an api deployed before step 1 answers 500 to `destination_tag` and nothing else changes, and that a syncer with the `ingest` worker refuses to boot without the table.
- [ ] **Step 4: Run the whole suite.** Each of these exits 0; put the test counts in the commit body:
  - `pnpm build`
  - `pnpm test`
  - `pnpm --filter @gatehub/data-api-shared test:e2e`
  - `pnpm --filter @gatehub/data-syncer test:e2e`
  - `pnpm --filter @gatehub/data-api-service test:e2e`
- [ ] **Step 5: Commit.** `git add docs/backfill.md docs/operations.md docs/clickhouse.md docs/deployment.md docs/README.md docs/architecture.md` — `docs: rollout, re-ingest and the table counts for transactions by destination tag`.

---

## Notes on the spec

1. **Recorded cases instead of some synthetic ones.** Spec §9 asks for synthetic cases of a failed transaction, a Batch inner transaction and Xahau's `Remit`. Recordings of all three exist, and of tag 0 too (Task 1's table), so the plan uses them. The synthetic cases are the edits Task 1 names.
2. **Types without a tagged recording.** "Recorded ledgers of each type that has the fields" holds only for `Payment` and `Remit`. `EscrowCreate`, `CheckCreate`, `PaymentChannelCreate`, `AccountDelete` and `Invoke` are edits of recorded transactions without a tag. The newer types of spec §3 have no recording at all, and a made-up type proves that the rule reads the fields.
3. **The mutation of spec §7** is an in-suite control: a copy of the table without the tag in its key, swapped in. Task 5's Step 3 adds a manual mutation of the read.
4. **The spec's status line** still says "draft for the owner's review". The owner approved it on 2026-11-06; the plan leaves the spec as it is.
