# Ledger features: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest, store and serve:
- price oracles;
- identity objects (DID, Credentials, Permissioned Domains, Delegate);
- clawbacks, checks, and IOU escrows and payment channels typed correctly;
- permissioned-DEX domains on exchanges, tickets, and Batch grouping.

**Architecture:**
- A generic `object_changes` ledger table, with an account index, records the tracked object types.
- Dedicated ledger tables hold oracles, clawbacks, checks and batch.
- The exchange and balance-change parsers are extended.
- An oracle aggregator job runs alongside them.
- New routes serve it all.

**Tech Stack:** as in `2026-10-17-amm-data.md`.

**Spec:** `docs/superpowers/specs/2026-10-17-ledger-features-design.md`; shared rules in `2026-10-17-amendments-roadmap.md`. **Depends on:** the MPT plan, completed. The MPT plan provides MPT amounts, which clawbacks of MPTs reference.

## Global Constraints

Identical to `docs/superpowers/plans/2026-10-17-amm-data.md` → Global Constraints. In addition:
- **Branch and version:** branch `feat/ledger-features`, cut from the finished `feat/mpt-data`. `PARSER_VERSION` = 5.
- **Object ids:** ids of credentials, domains, checks and oracle documents are validated:
  - 64-hex ledger ids give 400 `invalid <thing> id`;
  - `document_id` must be a UInt32, otherwise 400 `invalid document id`.
- **`object_changes` storage:** `fields` holds JSON text produced by `JSON.stringify` of the decoded fields, with sorted keys so it is deterministic.

## Review Focus

1. **A Batch whose inner transaction fails, in `all_or_nothing` mode.**
   - The failing inner transaction and the inner transactions rolled back with it must be recorded with their results.
   - The outer transaction must link to every inner one.
   - Owner: Task 6.
2. **An `OracleSet` that updates some pairs and omits others.** Omitted pairs keep their previous price; `fixPriceOracleOrder` affects their order. The current series must equal the node's `Oracle` object, not just the transaction's entries. Owner: Task 3.
3. **A check cashed with `DeliverMin`.** The `delivered` amount must come from the actual balance changes, not from `DeliverMin`. Owner: Task 4.
4. **A hybrid offer.** It sits in both the open book and a domain. The trades it takes part in must be attributed by the taker transaction's `DomainID` rule, without double counting. Owner: Task 5.
5. **An IOU escrow on XRPL.** It must not appear as a payment-type balance change of the trust line before finish. If FINDINGS shows that the trust line is debited at create, the typing follows the ledger and the docs say so. Owner: Task 4.

---

### Task 1: Fixtures and findings

**Files:**
- Create: `packages/shared/test/fixtures/{xrpl,xahau}/features/` (ledgers, `manifest.json`, `FINDINGS.md`)

- [ ] **Step 1: Find and record the case list of spec §5** with `record-fixtures --txs`, at most 2 requests in flight, on `wss://s2.ripple.com` and `wss://xahau.network`. Case names follow the list in spec §5, in `snake_case`.
- [ ] **Step 2: Write `FINDINGS.md`** with the three confirmations of spec §5, plus anything that differs from the spec's ledger descriptions. List any missing cases.
- [ ] **Step 3: Commit.**

### Task 2: Schema, tables and rows

**Files:**
- Modify: `packages/shared/schema/001_baseline.sql`, `packages/shared/src/clickhouse/{tables,rows}.ts`, `packages/shared/src/ingest/ingest-state.ts`
- Test: `migrate.e2e-spec.ts`, `ingest-state.spec.ts`

**Interfaces:**
- Produces:
  - ledger tables `Table.ObjectChanges`, `AccountObjectChanges`, `OracleUpdates`, `OraclePricesByPair`, `Clawbacks`, `AccountClawbacks`, `CheckEvents`, `BatchTransactions` and `BatchByInner`;
  - aggregates `Table.Oracles` and `OracleDaily`;
  - an `exchanges` / `account_exchanges` `domain_id` column;
  - row types per spec §1.

- [ ] **Step 1: Write the failing tests.** Keys and partitions are asserted, and deletes cover every new ledger table.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all unit suites and `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Object-change and oracle parsers

**Files:**
- Create: `packages/shared/src/parsers/object-changes.parser.ts`, `oracle.parser.ts` (+ specs, oracle test helpers)

**Interfaces:**
- Produces:
  ```ts
  export const TRACKED_OBJECT_TYPES: readonly string[];  // ['DID','Credential','PermissionedDomain','Delegate','Check','Ticket','Oracle']
  export interface ParsedObjectChange { object_type: string; object_id: string; action: 'created'|'modified'|'deleted';
    owner: string; accounts: string[]; fields: string; }
  export class ObjectChangesParser { parse(t: ParserTx, ctx: ParseContext): ParsedObjectChange[]; }
  export interface ParsedOracleUpdate { owner: string; document_id: number; pair_index: number; action: 'set'|'remove_pair'|'delete';
    base_asset: string; quote_asset: string; asset_price_raw?: string; scale?: number; price?: string; last_update_time?: number;
    provider?: string; asset_class?: string; uri?: string; }
  export class OracleParser { parse(t: ParserTx, ctx: ParseContext): ParsedOracleUpdate[]; }
  ```

- [ ] **Step 1: Write the failing tests.**
  - Every tracked-type case gives the right `action`, `owner`, `accounts` and deterministic `fields`. Untracked types give nothing.
  - Oracle cases: set, update, remove-pair and delete. Review Focus 2: the current series equals the node's final `PriceDataSeries`.
  - The price is exact (raw × 10^−scale).
  - Both networks.
  - The oracle-implementation test and deep-frozen input.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Kill at least 10 mutants.
- [ ] **Step 5: Commit.**

### Task 4: Clawback, check and token-escrow parsing

**Files:**
- Create: `packages/shared/src/parsers/clawback.parser.ts`, `check.parser.ts` (+ specs)
- Modify: `packages/shared/src/parsers/balance-changes.parser.ts` (+ spec)

**Interfaces:**
- Produces: `ClawbackParser.parse` gives `{issuer, holder, currency, amount_issuer, amount, requested}[]`, and `CheckParser.parse` gives check events per spec §1.
- Produces: IOU escrow and channel typing in balance changes.

- [ ] **Step 1: Write the failing tests.**
  - IOU, MPT and Xahau clawbacks: `amount` equals the holder's delta.
  - Check create, cash, cancel and removed. Review Focus 3.
  - IOU escrow typing on XRPL, following FINDINGS (Review Focus 5).
  - Xahau IOU channel typing.
  - Every existing balance-change golden snapshot is unchanged for non-token escrows.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 5: Domains on exchanges

**Files:**
- Modify: `packages/shared/src/parsers/exchanges.parser.ts` and `amm.parser.ts` (`domain_id`), `apps/api/src/common/params.ts` (`domainFilter`), the exchange services, controllers and object
- Test: parser specs, `apps/api/test/exchanges.e2e-spec.ts`, `account-exchanges.e2e-spec.ts`, `paged-reads.e2e-spec.ts`

**Interfaces:**
- Produces: `domainFilter(q): {kind: 'any'} | {kind: 'none'} | {kind: 'id', id: string}`. An invalid value gives 400 `invalid domain filter`.
- Produces: `ExchangeObject.domain_id?`, as the last key, only when set.

- [ ] **Step 1: Write the failing tests.**
  - A domain offer, a domain payment and Review Focus 4 (hybrid).
  - The filter values on every exchange route, combined with `amm`.
  - The `read_rows` bound for `domain=<id>` over a mostly open book.
  - Every existing parity test is unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 6: Ingest integration, including the batch pass

**Files:**
- Modify: `packages/shared/src/ingest/build-rows.ts`, `rows.ts` (`PARSER_VERSION = 5`), `prometheus.service.ts`, `live-runner.ts`, `range-ingest.ts`
- Test: `build-rows.spec.ts`, `ledger-writer.e2e-spec.ts`, `range-ingest.e2e-spec.ts`

**Interfaces:**
- Produces: `LedgerRows` gains `objectChanges`, `accountObjectChanges`, `oracleUpdates`, `oraclePricesByPair`, `clawbacks`, `accountClawbacks`, `checkEvents`, `batchTransactions` and `batchByInner`, all in `CHILD_TABLES`. `diagnostics.batchOrphans` feeds `syncer_batch_orphan_inner_total`.

- [ ] **Step 1: Write the failing tests.**
  - All the fixtures land in every table.
  - Review Focus 1 (Batch modes and the failing inner transaction).
  - An orphan inner transaction (synthetic) is counted.
  - Recovery and redo, and real duplicates.
  - Ripple-mock output is unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm build`, `pnpm test` and `pnpm -r --no-bail test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 7: Oracle aggregator jobs

**Files:**
- Create: `packages/shared/src/aggregate/oracle.job.ts` (+ e2e)
- Modify: `apps/syncer/src/aggregator/aggregator.service.ts` (+ spec)

**Interfaces:**
- Produces:
  - `recomputeOracles(ch, keys, opts?)` and `computeOracleDaily(ch, day, opts?)`;
  - jobs `oracle_state` (every tick, `AGGREGATOR_ORACLE_STATE_BUDGET_MS = 2000`) and `oracle_daily` (every 5 ticks).

- [ ] **Step 1: Write the failing tests.**
  - The current state equals the last series.
  - Daily open, high, low, close, mean and median close, and the updates and oracle counts, match the oracle.
  - Finality, version sets and idempotence; real duplicates.
  - No starvation with every job of families 1–4 registered.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 8: Oracle routes

**Files:**
- Create: `apps/api/src/oracles/{oracles.module.ts, oracles.controller.ts, oracles.service.ts, oracle-objects.ts}` (+ specs)
- Test: `apps/api/test/oracles.e2e-spec.ts`

**Interfaces:**
- Produces the oracle routes of spec §3.
  - 500 messages: `unable to retrieve oracles`, `unable to retrieve oracle`, `unable to retrieve oracle history`, `unable to retrieve prices`.
  - 404 message: `oracle not found`.
  - 400 messages: `invalid document id`, `invalid interval`, `invalid asset`.

- [ ] **Step 1: Write the failing tests.**
  - The shared list tests and the filters.
  - The `:base/:quote` form, including a 40-hex asset served with its text.
  - Days equal `oracle_daily`.
  - EXPLAIN and `read_rows` bounds.
  - Both networks.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 9: Identity, clawback, check, ticket and batch routes

**Files:**
- Create: `apps/api/src/objects/{objects.module.ts, identity.controller.ts, checks.controller.ts, objects.service.ts, object-views.ts}`, `apps/api/src/accounts/{account-identity.controller.ts, account-clawbacks.controller.ts, account-checks.controller.ts, account-tickets.controller.ts}`, `apps/api/src/transactions/batch.controller.ts` (+ specs)
- Test: `apps/api/test/identity.e2e-spec.ts`, `checks.e2e-spec.ts`, `clawbacks.e2e-spec.ts`, `tickets.e2e-spec.ts`, `batch.e2e-spec.ts`

**Interfaces:**
- Produces the remaining routes of spec §3, each with a 500 message `unable to retrieve <thing>` and the 404 and 400 messages named there. `object-views.ts` maps each tracked type's `fields` JSON to its response object with pinned key order:
  - DID: `uri`, `did_document`, `data`;
  - Credential: `subject`, `issuer`, `credential_type`, `accepted`, `expiration`, `uri`;
  - Domain: `owner`, `sequence`, `accepted_credentials`;
  - Delegate: `account`, `authorize`, `permissions`;
  - Check: the check fields;
  - Ticket: `ticket_sequence`.

- [ ] **Step 1: Write the failing tests.**
  - The shared list tests per list.
  - The roles and statuses.
  - The `history` flag.
  - A credential that is expired or not accepted is hidden by default.
  - Batch lookup by outer and by inner hash.
  - EXPLAIN and `read_rows` bounds.
  - Xahau gives 404 or empty for the XRPL-only parts, and tickets work on both networks.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the API suites and `main.e2e-spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 10: Documentation

**Files:**
- Create: `docs/adr/0014-ledger-features.md`
- Modify: `docs/api-reference.md`, `docs/data-model.md`, `docs/syncer.md`, `docs/operations.md`, `docs/openapi.yaml`, ADR-0010 (the `domain` filter and `domain_id` field; IOU escrow typing)

- [ ] **Step 1: Write the docs.** Include the enablement ledgers of each amendment, found from `EnableAmendment`.
- [ ] **Step 2: Verify** the OpenAPI file and links.
- [ ] **Step 3: Commit.**

### Task 11: Verification

**Files:**
- Create: `docs/superpowers/plans/2026-10-17-ledger-features.verification.md`

- [ ] **Step 1: Run the full suites.**
- [ ] **Step 2: Live bounded check.** In an isolated project, range-ingest about 300 recent ledgers per network. Then compare:
  - 3 oracles with `ledger_entry` (`oracle`);
  - 2 credentials and 1 domain with `ledger_entry`;
  - open checks and tickets of 2 accounts with `account_objects` (types `check`, `ticket`);
  - 2 Batch transactions with `tx` on their inner hashes.

  Stop on a rate-limit answer.
- [ ] **Step 3: Report.** Tear down.
- [ ] **Step 4: Commit.**
