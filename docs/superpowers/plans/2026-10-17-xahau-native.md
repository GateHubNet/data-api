# Xahau-native features: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest, store and serve Xahau hooks, rewards, imports, Remit, Cron and Remarks, with reward and import volume and daily stats.

**Architecture:**
- Four pure parsers write the hook, reward, import and Remit/Cron/Remarks ledger tables.
- The generic `object_changes` table of family 4 tracks `Hook`, `HookDefinition` and `Cron`.
- Aggregator jobs build `hooks`, `hook_daily`, `reward_daily` and `import_daily`, and add the `reward_volume` and `import_volume` metrics. Payment volume reads `remit_amounts`.
- New routes serve everything. They answer empty or 404 on XRPL.

**Tech Stack:** as in `2026-10-17-amm-data.md`.

**Spec:** `docs/superpowers/specs/2026-10-17-xahau-native-design.md`; shared rules in `2026-10-17-amendments-roadmap.md`. **Depends on:** the ledger-features plan, completed (`object_changes`; the URIToken events of the NFT plan).

## Global Constraints

Identical to `docs/superpowers/plans/2026-10-17-amm-data.md` → Global Constraints. In addition:
- **Branch:** `feat/xahau-native`, cut from the finished `feat/ledger-features`. `PARSER_VERSION` = 6.
- **Validation:** a hook hash must be 64 hex characters, otherwise 400 `invalid hook hash`. An object id must be 64 hex characters, otherwise 400 `invalid object id`.
- **Import blobs:** a blob is decoded with a 1 MB cap. A blob that cannot be decoded yields an `imports` row with `kind = 'unknown'` and the counter `syncer_import_undecodable_total`. It never fails the ledger.
- **Fixtures:** use `wss://xahau.network`, `--concurrency 1` and 1 request in flight. It throttles heavily (see the drop-in verification report, finding F3).

## Review Focus

1. **A hook that runs on a failed (`tec*`) transaction.** Its execution must be recorded, if FINDINGS confirms that hooks run there, with the transaction's result available for filtering. Owner: Task 3.
2. **A `GenesisMint` whose parent claim is in an earlier ledger, before the ingest start.** The reward pairing must still list the mint, with the claim unknown. Owner: Tasks 7 and 9.
3. **A `SetHook` that overrides one position, deletes another and leaves the rest as no-ops in one transaction.** Exactly the changed positions get rows, and `/v2/accounts/:a/hooks` equals the node's `Hook` object. Owner: Task 3.
4. **An undecodable or oversized `Import` blob.** It is recorded as `unknown` and counted, and the ledger still commits. Owner: Task 5.
5. **A Remit with 0 amounts but a URIToken transfer and a mint.** It is listed with `amount_count = 0`, contributes nothing to payment volume, and family 2's events show the transfer and mint. Owner: Task 6.

---

### Task 1: Xahau fixtures and findings

**Files:**
- Create: `packages/shared/test/fixtures/xahau/native/` (ledgers, `manifest.json`, `FINDINGS.md`)

- [ ] **Step 1: Find and record the case list of spec §5** with `record-fixtures --txs`, using `account_tx` on the genesis account, known hook accounts and Remit users. Case names follow spec §5 in `snake_case`.
- [ ] **Step 2: Write `FINDINGS.md`.** Confirm:
  - the `HookResult` code meanings;
  - whether hooks execute on `tec*`;
  - the import kinds and the B2M rule;
  - the `Cron` pseudo-transaction fields;
  - the `Hook` object's position layout.

  List any missing cases.
- [ ] **Step 3: Commit.**

### Task 2: Schema, tables and rows

**Files:**
- Modify: `packages/shared/schema/001_baseline.sql`, `packages/shared/src/clickhouse/{tables,rows}.ts`, `packages/shared/src/ingest/ingest-state.ts`, `packages/shared/src/parsers/object-changes.parser.ts` (tracked types gain `Hook`, `HookDefinition`, `Cron`)
- Test: `migrate.e2e-spec.ts`, `ingest-state.spec.ts`, `object-changes.parser.spec.ts`

**Interfaces:**
- Produces:
  - every ledger table of spec §1, with P6/P7 as listed, in `LEDGER_KEYED_TABLES`;
  - the aggregates `hooks`, `hook_daily`, `reward_daily` and `import_daily`;
  - row types;
  - `HookDefinition` `fields` without `CreateCode` and with `code_size`.

- [ ] **Step 1: Write the failing tests.**
  - Keys and partitions are asserted.
  - Deletes cover every new ledger table.
  - `HookDefinition` changes have no `CreateCode`, and `code_size` equals the code byte length.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all unit suites and `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Hooks parser

**Files:**
- Create: `packages/shared/src/parsers/hooks.parser.ts` (+ spec), test oracle helpers

**Interfaces:**
- Produces:
  ```ts
  export interface ParsedHookExecution { execution_index: number; hook_account: string; hook_hash: string;
    result: 'accept'|'rollback'|'error'|'unknown'; result_raw: number; return_code: string; return_string: string;
    return_text: string; instructions: string; emit_count: number; state_changes: number; flags: number; }
  export interface ParsedHookEmission { emission_index: number; emitted_txn_id: string; hook_account: string; hook_hash: string; emit_nonce: string; }
  export interface ParsedHookInstall { account: string; position: number;
    action: 'install'|'update'|'delete'|'namespace_delete'|'noop'; hook_hash?: string; namespace?: string; hook_on?: string;
    api_version?: number; parameters?: string; grants?: string; flags: number; }
  export class HooksParser { parse(t: ParserTx, ctx: ParseContext): { executions: ParsedHookExecution[];
    emissions: ParsedHookEmission[]; installs: ParsedHookInstall[] }; }
  ```
  Unlike the other parsers, `HooksParser` runs on every transaction result, per FINDINGS.

- [ ] **Step 1: Write the failing tests.**
  - Every hook case from Task 1.
  - Review Focus 1 and Review Focus 3.
  - `return_text` is set only for printable ASCII.
  - The invariant that execution indexes are unique.
  - The oracle and deep-frozen input.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Kill at least 10 mutants.
- [ ] **Step 5: Commit.**

### Task 4: Rewards parser

**Files:**
- Create: `packages/shared/src/parsers/rewards.parser.ts` (+ spec)

**Interfaces:**
- Produces: `RewardsParser.parse` gives `{claims: [{account, issuer, opt_out}], mints: [{mint_index, destination, amount, parent_tx_hash, emit_hook_hash}]}`.

- [ ] **Step 1: Write the failing tests.**
  - A claim with opt-in and with opt-out.
  - A `GenesisMint` with several entries.
  - The invariant: each mint amount equals the destination's balance delta in the same transaction.
  - The oracle.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 5: Import parser

**Files:**
- Create: `packages/shared/src/parsers/import.parser.ts` (+ spec)

**Interfaces:**
- Produces: `ImportParser.parse` gives `{kind, xrpl_tx_hash?, xrpl_account?, xrpl_ledger?, xrpl_tx_type?, burned?, minted, account_created, issuer?}[]`. It uses the bundled XRPL definitions to decode the XRPL transaction.
- Produces: `diagnostics.importUndecodable`.

- [ ] **Step 1: Write the failing tests.**
  - Each import kind from Task 1, with `xrpl_tx_hash` equal to the hash recomputed from the decoded blob.
  - `minted` equals the `AccountRoot` delta, including a newly created account.
  - Review Focus 4: a synthetic garbage blob and a blob over 1 MB.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 6: Remit, Cron and Remarks parser

**Files:**
- Create: `packages/shared/src/parsers/xahau-misc.parser.ts` (+ spec)

**Interfaces:**
- Produces: `XahauMiscParser.parse` gives:
  - `remits: [{account, destination, amount_count, uritoken_count, minted_uritoken_id?, inform?, blob_size, invoice_id?, destination_tag?, amounts: [{amount_index, currency, issuer?, amount}]}]`
  - `cronRuns: [{owner, scheduled_ledger, hook_executions}]`
  - `remarks: [{object_id, name, account, action, value_hex?, value_text?, immutable, object_type}]`

- [ ] **Step 1: Write the failing tests.**
  - Every Remit case, with Review Focus 5. The invariant: the amount count equals `Amounts`.
  - The Cron run.
  - Remarks set, delete and immutable.
  - The oracle.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 7: Ingest integration

**Files:**
- Modify: `packages/shared/src/ingest/build-rows.ts`, `rows.ts` (`PARSER_VERSION = 6`), `prometheus.service.ts`, `live-runner.ts`, `range-ingest.ts`
- Test: `build-rows.spec.ts`, `ledger-writer.e2e-spec.ts`, `range-ingest.e2e-spec.ts`

**Interfaces:**
- Produces: `LedgerRows` gains a key per new ledger table, all in `CHILD_TABLES`. The parsers run only when `ctx.nativeCurrency === 'XAH'`. On XRPL every new array is empty.

- [ ] **Step 1: Write the failing tests.**
  - The Xahau fixtures land in every table.
  - XRPL fixtures produce no rows in the new tables.
  - Recovery and redo, and real duplicates.
  - The counter.
  - Ripple-mock output is unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm build`, `pnpm test` and `pnpm -r --no-bail test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 8: Aggregator jobs and volume metrics

**Files:**
- Create: `packages/shared/src/aggregate/{hooks.job.ts, xahau-daily.job.ts}` (+ e2e)
- Modify: `packages/shared/src/aggregate/volume.job.ts` (`reward_volume`, `import_volume`, remit amounts in payment volume), `apps/syncer/src/aggregator/aggregator.service.ts` (+ spec)

**Interfaces:**
- Produces:
  - `recomputeHooks(ch, hashes, opts?)` and `computeHookDaily`, `computeRewardDaily` and `computeImportDaily` (day-based);
  - metrics `reward_volume` (components `rewards`, `other_mints`; live day/7day/30day) and `import_volume` (components per kind);
  - jobs `hooks` (every tick, `AGGREGATOR_HOOKS_BUDGET_MS = 2000`) and `xahau_daily` (every 5 ticks). Both are registered only when the network is Xahau.

- [ ] **Step 1: Write the failing tests.**
  - Hook totals and daily numbers match the oracle.
  - Reward pairing classifies mints by their parent type through `tx_by_hash`, including Review Focus 2 (the parent is unknown, so the mint counts as `other_mints`).
  - Import daily and volume.
  - Payment volume on Xahau includes Remit amounts.
  - Finality, version sets and idempotence.
  - No starvation with every job of families 1–5 registered.
  - On XRPL the Xahau jobs are not registered.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 9: Hook routes and the transaction hooks route

**Files:**
- Create: `apps/api/src/hooks/{hooks.module.ts, hooks.controller.ts, hooks.service.ts, hook-objects.ts}`, `apps/api/src/accounts/account-hooks.controller.ts`, `apps/api/src/transactions/tx-hooks.controller.ts` (+ specs)
- Test: `apps/api/test/hooks.e2e-spec.ts`

**Interfaces:**
- Produces the hook routes of spec §3.
  - 500 messages: `unable to retrieve hooks`, `unable to retrieve hook`, `unable to retrieve hook executions`, `unable to retrieve hook installs`, `unable to retrieve hook stats`, `unable to retrieve transaction hooks`.
  - 404 message: `hook not found`.
  - 400 messages: `invalid hook hash`, `invalid result`, `invalid action`, `invalid sort`.

- [ ] **Step 1: Write the failing tests.**
  - The shared list tests and the filters.
  - The current account hooks equal the `Hook` object (Review Focus 3).
  - The transaction hooks route for a parent and for an emitted transaction.
  - EXPLAIN and `read_rows` bounds.
  - An XRPL harness answers empty or 404.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 10: Reward, import, Remit, Cron and Remarks routes

**Files:**
- Create: `apps/api/src/xahau/{xahau.module.ts, rewards.controller.ts, imports.controller.ts, remits.controller.ts, cron.controller.ts, remarks.controller.ts, xahau.service.ts, xahau-objects.ts}` (+ specs)
- Modify: `apps/api/src/network/volume.controller.ts` (`reward_volume`, `import_volume`)
- Test: `apps/api/test/xahau-native.e2e-spec.ts`, `apps/api/test/volume.e2e-spec.ts`

**Interfaces:**
- Produces the remaining routes of spec §3, each with a 500 message `unable to retrieve <thing>` and the 404 and 400 messages named there. The volume routes use `error getting data`.

- [ ] **Step 1: Write the failing tests.**
  - The shared list tests.
  - Reward pairing, including the unpaired cases (Review Focus 2).
  - Import kinds.
  - Remit amounts and URIToken ids (Review Focus 5).
  - Cron current state and runs.
  - Remarks current and history.
  - The volume routes.
  - EXPLAIN and `read_rows` bounds.
  - An XRPL harness answers empty or 404.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the API suites and `main.e2e-spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 11: Documentation

**Files:**
- Create: `docs/adr/0015-xahau-native-features.md`
- Modify: `docs/api-reference.md`, `docs/data-model.md`, `docs/syncer.md`, `docs/operations.md`, `docs/openapi.yaml`, ADR-0010 (Remit counts in payment volume on Xahau)

- [ ] **Step 1: Write the docs.** Include the Xahau genesis note: history starts at genesis, so a full `range-ingest --reprocess` from ledger 1 is needed.
- [ ] **Step 2: Verify** the OpenAPI file and links.
- [ ] **Step 3: Commit.**

### Task 12: Verification

**Files:**
- Create: `docs/superpowers/plans/2026-10-17-xahau-native.verification.md`

- [ ] **Step 1: Run the full suites.**
- [ ] **Step 2: Live bounded check (Xahau).** Use `--concurrency 1` and stop on rate limits. Range-ingest about 300 recent ledgers. Then compare:
  - the hooks of 2 accounts with `account_objects` (type `hook`);
  - 2 hook definitions with `ledger_entry` (`hook_definition`);
  - 3 transactions' hook executions with `tx` metadata;
  - 1 reward claim and its mint with `tx`;
  - 1 import's XRPL hash with its decoded blob;
  - 1 Remit.
- [ ] **Step 3: Report.** Tear down.
- [ ] **Step 4: Commit.**
