# Ledger Objects and Delegation (D5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index the history of every escrow, check, payment channel and `Delegate` entry on XRPL and Xahau, keep the escrowed native total for D7, serve objects, their history and an account's delegations, and book a delegated transaction's fee to the delegate who paid it.

**Architecture:** Migration `013` adds two ledger tables (`object_changes`, `account_object_changes`, written by ingest from `OBJECT_PARSER_VERSION = 7`) and the `escrows` aggregate. A pure `ObjectChangesParser` turns every created, modified or deleted node of a tracked type into a row holding its state after the transaction and the event it was; the balance-change and affected-account parsers learn the fee payer and the delegate. The aggregator's `escrows` job folds escrow rows into current state and writes, last on every run, a sentinel row holding the escrowed total and its watermark (D7's `readEscrowed`). A new API module reads an object's state and history at query time, evaluates a time-derived `status` at the newest committed ledger, and takes `coverage` from D3's `FeatureCoverageService`, in whose registry D5 declares four features.

**Tech Stack:** TypeScript (strict), NestJS 10, ClickHouse 26.8 (`@clickhouse/client`), pnpm 10 workspace, jest + ts-jest, testcontainers, supertest, `bignumber.js`, `ripple-address-codec`, Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-10-24-ledger-objects-delegation-design.md` (cited as "§n"). What the explorer reads of it: `x-explorer/docs/superpowers/specs/2026-10-24-ledger-object-pages-design.md` (E10). Executors read the spec with this plan.

**Branch:** `feat/explorer-data-2` in `DAPI = /Users/golobitch/github.com/GateHubNet/data-api-worktrees/explorer-data-2` (stacked on PR #20). Before Task 1 the D-env, D3 and D4 plans are built on this branch. Commit there; never push, never touch another worktree.

## Consumed from the earlier plans

Names as the earlier plans define them (D-env `2026-10-24-testnet-profiles.md`, D3 `2026-10-17-nft-data.md`, D4 `2026-10-24-display-names.md`); a task that uses one says "(D-env)", "(D3)" or "(D4)".

| Piece | From | Where |
|---|---|---|
| `NetworkProfile.family: NetworkFamily` (`'xrpl' \| 'xahau'`), `kind`, the four profiles, `NETWORK_NAMES`, `config/definitions/<testnet>.json` | D-env | `packages/shared/src/network/network-profile.ts` |
| `NetworkProfile.firstLedger: number \| undefined` (xrpl 32570, xahau 1, testnets undefined) | D3 Task 3 | the same file |
| `COVERAGE_FEATURES` (`{ parserVersion, startOf(profile): FeatureStart }`, `FeatureStart` = `{ kind: 'amendment'; amendment } \| { kind: 'first_ledger' } \| { kind: 'unavailable' }`), `CoverageFeatureName` | D3 Task 3 | `apps/api/src/common/coverage-features.ts` |
| `FeatureCoverageService.coverage(name)`, `.itemCoverage(name, createdLedger)`, `.isAvailable(name)`, `Coverage { from_ledger_index?; complete }`, `COVERAGE_KEYS`, `FEATURE_COVERAGE_CACHE_MS`; the global `FeatureCoverageModule`; the placement right after `result` | D3 Task 3 | `apps/api/src/common/feature-coverage.service.ts`, `feature-coverage.module.ts` |
| Migration `011`, `NFT_PARSER_VERSION = 5`, ADR-0016, ADR-0010 Amendment 5; the `nft_state` job after `amm_pools` and its hook in `hooksOfSlice` (run with or without the `aggregates` option) | D3 | `packages/shared/schema/`, `rows.ts`, `apps/syncer/src/aggregator/` |
| Migration `012`, `DOMAIN_PARSER_VERSION = 6`, ADR-0017, ADR-0010 Amendment 6, its rows in `buildLedgerRows` | D4 | the same places |

## Global Constraints

- Commands from the worktree root: `pnpm install` (once), `pnpm build`, `pnpm test`, `pnpm --filter @gatehub/data-api-shared test:e2e`, `pnpm --filter @gatehub/data-api-service test:e2e`, `pnpm --filter @gatehub/data-syncer test:e2e` (testcontainers; Docker is available), each narrowed with `-- <pattern>`. The apps import the compiled `dist/` of `packages/shared`: run `pnpm --filter @gatehub/data-api-shared build` after changing shared and before running app tests.
- Before each commit: `pnpm format`, `pnpm build`, `pnpm test` and the `test:e2e` of every package the task touched exit 0.
- Commits: Conventional Commits (`feat(shared): …`, `feat(syncer): …`, `feat(api): …`, `test: …`, `docs: …`), a body that says why, and the last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Name the files in `git add` (never `-A`), never `--amend`, never touch `.claude/`. Delete nothing you did not create in the task.
- Numbers, each checked by the first step of the task that takes it (if PR #20, D3 or D4 took more, use the next free value and change every reference in that task): migration `packages/shared/schema/013_ledger_objects.sql` (Task 3); `OBJECT_PARSER_VERSION = 7` and `PARSER_VERSION = 7` (Task 6); `docs/adr/0018-ledger-object-history.md` and ADR-0010 "Amendment 7" with items after the highest item number (Task 14). Never edit an earlier migration.
- Repo conventions (`docs/development.md` §5): table names only from `Table`; every user-derived value bound as a query parameter; no `FINAL`; key-ordered reads; exact decimals with `BigNumber` (`toFixed()`, never exponent notation, for any amount this code computes); config only through the config classes; everything new of `packages/shared` exported from `src/index.ts` (and from `src/network/index.ts` for what a config class imports).
- Object IDs: 64 hex digits in either case on the way in (400 otherwise), stored and answered in upper case. Classic addresses only: an X-address is `invalid ripple address`.
- Times: ledger fields are Ripple-epoch seconds; `+ 946_684_800` gives unix seconds; answers write them with the API's `fmtTime` (`YYYY-MM-DDTHH:mm:ssZ`).
- Amounts in answers (`ObjectAmount`, §5.1): native drops as `{ currency: 'XRP' | 'XAH', value: dropsToNative(drops) }`; an issued token as on the ledger (`{ currency, issuer, value }`, `value` the ledger's text, hex currency codes kept); an MPT as `mptAmountObject(id, value)` (Task 2: `{ currency: <ID>, issuer, value, mpt_issuance_id: <ID> }`, the 48-hex ID upper case, `issuer` read from the ID, `value` the raw integer units). Amounts this code computes (`remaining`, `amount_change`, `balance_change`) are plain decimals in the object's currency. A key with no value is absent, never `null`.
- Every answer of §5 except `ledger_objects/{id}` starts `result, coverage, ledger_index, close_time`; `coverage` comes only from D3's `FeatureCoverageService` (`coverage(name)` for a list, `itemCoverage(name, created)` for one object) over the four features Task 10 registers; D5 computes no coverage of its own, and none is in a CSV. Key orders are the `*_KEYS` constants of Task 9, pinned by tests.
- Every read of `object_changes` is capped at `H`, the newest committed ledger (`ledger_index <= {H}`), whose close time `T` the answer carries and `status` is evaluated at. With no committed ledger the object routes answer their 404 and the delegations route 500 `unable to retrieve delegations`.
- `Cache-Control` is the global `private, max-age=60`; no route sets its own.
- Error messages are exactly §5's. Metrics are syncer-only with the `syncer_` prefix; the API adds none.
- Fixtures recorded from public nodes need outbound network (at most two requests in flight); if unreachable, stop and report BLOCKED. Never hand-write data presented as recorded; a synthetic case is built in the test and says so.

## Review Focus

1. **A delegated transaction's fee.** The delegate pays it: its `transaction_cost` row in `balance_changes`, the CSV `fee` on its row, and its own `account_transactions` row (even a fee-free Batch inner one, which the metadata may not name); a transaction without `Delegate` is unchanged byte for byte. Tests: Task 5 `charges the fee of a delegated Payment to the delegate`, `leaves every balance-change snapshot unchanged`, `appends the delegate a fee-free inner transaction does not name`; Task 13 `puts the fee on the delegate's row and names the delegate last`.
2. **Status at the exact boundary second.** An escrow at `T = finish_after` is still `pending`, at `T = cancel_after` still `can_be_finished`, one second later `can_be_cancelled`; a check at `T = expiration` is `expired`; a channel at `T = cancel_after` is `closing`. Tests: Task 9 `object-status.spec.ts` boundary table; Task 10 `evaluates status at the close time of H`.
3. **An object whose creation is outside the coverage.** No `created`, the object's own `complete: false` while the feature's is false, and `complete: true` once the creation is indexed whatever the feature says; on a testnet every feature is `complete: false`; Xahau's delegations are `complete: true` with no table read. Tests: Task 10 `answers an escrow created before the coverage with complete false and no created`, `coverage-features.spec.ts` (Xahau, testnet); Task 12 `answers Xahau's delegations empty and complete without a read`.
4. **A payment channel with thousands of claims.** The detail embeds the newest 50 events and a working `history_marker`, finds `created` and `opened_with` beyond them, counts `funds` and `claims` over the whole history, and stays a bounded prefix read; history pages concatenate in both directions. Tests: Task 11 `a channel with 1,200 events: detail, marker, counts and creation`, `pages of a 1,200-event history concatenate both ways`, and its `paged-reads.e2e-spec.ts` bound.
5. **Escrows a re-ingest removes, and runs that change nothing.** The `escrows` row of an escrow whose rows vanished is deleted and the total drops; a run with nothing to do still writes a sentinel with a newer version and the head as watermark (D7 takes its ledger from it). Tests: Task 7 `deletes an escrow whose rows a re-ingest removed`, `writes the sentinel on a run with nothing to do`; Task 8 `moves the watermark to the head on a tick with no escrow`.

---

### Task 1: Recorded object cases and findings

**Files:**
- Create: `packages/shared/test/fixtures/xrpl/objects/` and `packages/shared/test/fixtures/xahau/objects/` (`<ledger>.json.gz`, `manifest.json`, `server_definitions.json`, `server_info.json`, `FINDINGS.md`, written by the recorder except `FINDINGS.md` and the manifest's `cases`)
- Create: `packages/shared/src/test-utils/object-cases.ts` (test-only: `src/test-utils` is excluded from the build), `packages/shared/src/ingest/object-fixtures.spec.ts`
- Modify: `packages/shared/test/fixtures/README.md` (sections "XRPL ledger object cases (`xrpl/objects/`)" and "Xahau ledger object cases (`xahau/objects/`)", in the style of "XRPL AMM cases": endpoint, date, validated head, a case table, a "Not found" list)

**Interfaces:**
- Produces (every later task's tests, and E10, which copies these ledgers):
  ```ts
  export type ObjectNet = 'xrpl' | 'xahau';
  /** The case names of this task, in order. */
  export const OBJECT_CASES: Readonly<Record<ObjectNet, readonly string[]>>;
  export function objectFixturesDir(net: ObjectNet): string;            // …/test/fixtures/<net>/objects
  export function objectLedgers(net: ObjectNet): RawLedger[];            // FixtureLedgerSource.fromDir(dir).list()
  /** The case's ledger and transaction; undefined for a case FINDINGS.md lists as not found. */
  export function objectCase(net: ObjectNet, name: string): { ledger: RawLedger; tx: RawTransaction } | undefined;
  ```
- Case names (manifest `cases.<name>` = `{ ledger, hash, type, note }`, the AMM cases' shape). XRPL: `escrow_create_timed` (FinishAfter and CancelAfter), `escrow_create_conditional`, `escrow_create_ticket` (Sequence 0, TicketSequence), `escrow_finish_timed`, `escrow_finish_fulfillment`, `escrow_cancel`, `escrow_create_token`, `escrow_finish_token`, `escrow_create_mpt`, `check_create_xrp`, `check_create_token` (InvoiceID and Expiration), `check_cash_amount`, `check_cash_deliver_min` (107,671,568 is one), `check_cancel_source`, `check_cancel_third_party_expired`, `channel_create`, `channel_fund_expiration`, `channel_claim`, `channel_close_request`, `channel_close_destination`, `channel_renew`, `channel_close_expired`, `delegate_set_create`, `delegate_set_replace`, `delegate_set_empty`, `delegated_payment`, `delegated_tec`, `delegated_batch_inner`. Xahau: `escrow_create`, `escrow_finish`, `escrow_finish_escrow_id`, `escrow_cancel`, `escrow_create_token`, `check_create`, `check_cash`, `channel_create`, `channel_claim`, `channel_create_token`, `channel_claim_token`.

`FINDINGS.md` (one heading per question, each answered from the recorded metadata or the node, with the ledger and hash that shows it): (1) `DeliveredAmount` in the metadata of an XRP cash and of an issued-token cash; (2) an issued-token escrow on XRPL: whose trust line moves at create and at finish (the spec expects the sender's at create, the destination's at finish, the issuer's mirrored rows untyped); (3) which transaction types delete a `Delegate` besides `DelegateSet` (AccountDelete expected); (4) Xahau's `Escrow` fields and an `EscrowFinish` with `EscrowID`; (5) Xahau's first ledger (it must equal D3's `firstLedger` of the `xahau` profile) and whether Xahau's `Amendments` object lists `Escrow`, `PayChan` and `Checks` (Ruling 1); (6) that a channel's first claim carries `PreviousFields.Balance` `"0"` (Task 11's `claims` count relies on it); (7) the 12 granular permission values of xrpl.org's "Permission Values" on the day (name, value, the transaction type it narrows; Task 2's table); (8) whether a delegated Batch inner transaction and an MPT escrow exist on mainnet (if not, listed under "Not found" and built synthetically in Tasks 4 and 5).

- [ ] **Step 1: Find and record the cases.** Find hashes with `account_tx` of busy escrow, check, channel and delegation accounts, or with `--want <Type> --scan N` (at most two requests in flight), on `wss://s2.ripple.com` (XRPL, full history) and `wss://xahau.network`. Record: `pnpm --filter @gatehub/data-api-shared record:fixtures -- --network xrpl --endpoint wss://s2.ripple.com --out test/fixtures/xrpl/objects --txs <hashes>` (and the same for Xahau), then add each case under the manifest's `cases`. A ledger above the recorder's 2 MB cap is replaced by another case of the same kind.
- [ ] **Step 2: Write `FINDINGS.md`, the README sections, `object-cases.ts` and the failing test.** `object-fixtures.spec.ts`:
  ```ts
  it.each(['xrpl', 'xahau'] as const)('%s: every case is recorded or listed as not found in FINDINGS.md', …);
  it.each(casesOf('xrpl'))('xrpl %s: its ledger holds the hash with the manifest type and a tesSUCCESS result (delegated_tec: a tec)', …);
  it.each(casesOf('xahau'))('xahau %s: the same', …);
  it('escrow_create_ticket has Sequence 0 and a TicketSequence', …);
  it('check_cash_deliver_min has DeliverMin and no Amount', …);
  it('delegated_payment and delegated_tec carry a Delegate other than Account', …);
  it('escrow_finish_escrow_id carries EscrowID', …);
  ```
- [ ] **Step 3: Run it.** `pnpm --filter @gatehub/data-api-shared test -- object-fixtures` → PASS once Step 2's files are in (it FAILS while a case is neither recorded nor listed).
- [ ] **Step 4: Commit.** `git add packages/shared/test/fixtures/xrpl/objects packages/shared/test/fixtures/xahau/objects packages/shared/test/fixtures/README.md packages/shared/src/test-utils/object-cases.ts packages/shared/src/ingest/object-fixtures.spec.ts` — `test: recorded escrow, check, channel and delegation cases with findings` (body: the parser and the API are tested against real metadata; the findings settle the spec's open questions).

---

### Task 2: Shared keys, amounts, permissions and the fee payer

**Files:**
- Create: `packages/shared/src/util/keylets.ts`, `packages/shared/src/util/mpt.ts`, `packages/shared/src/util/stable-json.ts`, `packages/shared/src/parsers/permissions.ts`, each with a `*.spec.ts`; `packages/shared/src/parsers/parser.interface.spec.ts`
- Modify: `packages/shared/src/parsers/parser.interface.ts` (`feePayer`), `packages/shared/src/network/network-profile.ts` (`hasDelegation`), `packages/shared/src/network/network-profile.spec.ts`, `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: Task 1 `objectLedgers`, `objectCase`; `senderAccount`, `ACCOUNT_ZERO` (`parser.interface.ts`); `decodeAccountID`, `encodeAccountID` (`ripple-address-codec`).
- Produces:
  ```ts
  // util/keylets.ts
  export const ESCROW_SPACE = 0x0075;
  /** SHA-512Half (first 32 bytes of SHA-512) of the big-endian UInt16 space key followed by `body`, 64 upper-case hex. */
  export function ledgerObjectSpace(space: number, body: Uint8Array): string;
  /** An escrow's ledger object ID: the space, the owner's AccountID, the big-endian UInt32 sequence. Throws on a bad address or a sequence outside UInt32. */
  export function escrowId(owner: string, sequence: number): string;
  // util/mpt.ts
  export interface MptAmountObject { currency: string; issuer: string; value: string; mpt_issuance_id: string }
  export function isMptIssuanceId(text: string): boolean;                       // 48 hex, either case
  export function mptIssuerOf(issuanceId: string): string;                       // encodeAccountID of bytes 4..24; throws on a bad ID
  export function mptAmountObject(issuanceId: string, value: string): MptAmountObject; // keys in this order, ID upper case
  // util/stable-json.ts
  export function stableStringify(value: unknown): string;                       // JSON.stringify with object keys sorted at every depth
  // parsers/permissions.ts
  export interface GranularPermission { name: string; value: number; transactionType: string }
  export const GRANULAR_PERMISSIONS: readonly GranularPermission[];               // the 12, by value
  export interface Permission { permission: string; kind: 'transaction' | 'granular' | 'unknown'; transaction_type?: string }
  export function permissionOf(value: unknown, transactionTypes: Readonly<Record<string, number>>): Permission;
  export function transactionTypesOf(profile: NetworkProfile): Readonly<Record<string, number>>; // TRANSACTION_TYPES of definitionsFallback(), {} without
  // parser.interface.ts
  /** Who pays the transaction's fee: its `Delegate` (a non-empty string), else `senderAccount(tx)`. */
  export function feePayer(tx: Readonly<Record<string, unknown>>): string | undefined;
  // NetworkProfile
  hasDelegation: boolean;   // xrpl true, xahau false, xrpl-testnet true, xahau-testnet false
  ```

`GRANULAR_PERMISSIONS` (the values FINDINGS (7) confirmed; these are xrpl.org's as of 2026-10): 65537 `TrustlineAuthorize`, 65538 `TrustlineFreeze`, 65539 `TrustlineUnfreeze` (TrustSet); 65540 `AccountDomainSet`, 65541 `AccountEmailHashSet`, 65542 `AccountMessageKeySet`, 65543 `AccountTransferRateSet`, 65544 `AccountTickSizeSet` (AccountSet); 65545 `PaymentMint`, 65546 `PaymentBurn` (Payment); 65547 `MPTokenIssuanceLock`, 65548 `MPTokenIssuanceUnlock` (MPTokenIssuanceSet). `permissionOf`, in this order: a granular name or value → `{ permission: name, kind: 'granular', transaction_type }`; a number (or a string of digits) n with `transactionTypes[name] === n - 1` → `{ permission: name, kind: 'transaction' }`; any other number → `{ permission: String(n), kind: 'unknown' }`; any other string (the node writes a name it knows) → `{ permission: value, kind: 'transaction' }`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // keylets.spec.ts
  it.each(['xrpl', 'xahau'] as const)('%s: every recorded EscrowCreate created the node escrowId names', …); // sequence = tx.Sequence || tx.TicketSequence
  it('refuses an X-address and a sequence of 2^32', …);
  // mpt.spec.ts
  expect(mptIssuerOf('0000012AB5F762798A53D543A014CAF8B297CFF8F2F937E8')).toBe('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
  const ID = '0000012AB5F762798A53D543A014CAF8B297CFF8F2F937E8';
  expect(mptAmountObject(ID.toLowerCase(), '2500000')).toEqual({ currency: ID, issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', value: '2500000', mpt_issuance_id: ID });
  expect(Object.keys(mptAmountObject(ID, '1'))).toEqual(['currency', 'issuer', 'value', 'mpt_issuance_id']);
  expect(() => mptIssuerOf('0000012A')).toThrow();
  // stable-json.spec.ts
  expect(stableStringify({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}');
  // permissions.spec.ts (T = transactionTypesOf of the xrpl profile)
  expect(permissionOf('Payment', T)).toEqual({ permission: 'Payment', kind: 'transaction' });
  expect(permissionOf(T.Payment + 1, T)).toEqual({ permission: 'Payment', kind: 'transaction' });
  expect(permissionOf(65538, T)).toEqual({ permission: 'TrustlineFreeze', kind: 'granular', transaction_type: 'TrustSet' });
  expect(permissionOf('TrustlineAuthorize', T)).toEqual({ permission: 'TrustlineAuthorize', kind: 'granular', transaction_type: 'TrustSet' });
  expect([permissionOf(70001, T), permissionOf('70001', T)]).toEqual([{ permission: '70001', kind: 'unknown' }, { permission: '70001', kind: 'unknown' }]);
  expect(GRANULAR_PERMISSIONS.map((p) => p.value)).toEqual([65537, 65538, …, 65548]);  // twelve, consecutive
  // parser.interface.spec.ts
  expect([feePayer({ Account: A, Delegate: D }), feePayer({ Account: A }), feePayer({ Account: '' }), feePayer({ Account: A, Delegate: '' })]).toEqual([D, A, ACCOUNT_ZERO, A]);
  // network-profile.spec.ts
  expect(NETWORK_NAMES.map((n) => getNetworkProfile(n).hasDelegation)).toEqual([true, false, true, false]);
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- keylets mpt stable-json permissions parser.interface network-profile` → FAIL: modules and properties missing.
- [ ] **Step 3: Implement** the modules, `feePayer` and the profile field (SHA-512 with Node `crypto`; `stableStringify` sorts with the default string order).
- [ ] **Step 4: Run them to verify they pass.** Step 2's command → PASS; `pnpm build` → exit 0.
- [ ] **Step 5: Commit.** `git add packages/shared/src/util packages/shared/src/parsers/permissions.ts packages/shared/src/parsers/permissions.spec.ts packages/shared/src/parsers/parser.interface.ts packages/shared/src/parsers/parser.interface.spec.ts packages/shared/src/network packages/shared/src/index.ts` — `feat(shared): escrow IDs, the MPT amount object, permissions and the fee payer` (body: one definition of each for the parser, the job and the API; the MPT amount object is the shape D9 adopts).

---

### Task 3: Migration 013 and row types

**Files:**
- Create: `packages/shared/schema/013_ledger_objects.sql`
- Modify: `packages/shared/src/clickhouse/tables.ts`, `packages/shared/src/clickhouse/rows.ts` (three row types), `packages/shared/src/ingest/ingest-state.ts` (`LEDGER_KEYED_TABLES` and its comment), `packages/shared/test/sample-rows.ts`, `packages/shared/test/migrate.e2e-spec.ts`, `docs/data-model.md` (the three tables, the table count, the migration row, the relationships diagram)

**Interfaces:**
- Produces: `Table.ObjectChanges = 'object_changes'`, `Table.AccountObjectChanges = 'account_object_changes'` (in the ledger-derived group), `Table.Escrows = 'escrows'` (in the aggregator group); `ObjectChangesRow`, `AccountObjectChangesRow`, `EscrowsRow` (fields = the columns of §1.1–1.3 in DDL order; `Enum8` → the union of its labels, `Nullable(T)` → `T | null`, `DateTime` → `UnixSeconds`, `UInt64` → `UInt64Value`); `LEDGER_KEYED_TABLES` gains `{ table: Table.ObjectChanges, partitionSize: P7 }` and `{ table: Table.AccountObjectChanges, partitionSize: P7 }` (not `escrows`: an aggregate, never deleted by recovery).

The DDL is §1.1–1.3 exactly (three `CREATE TABLE IF NOT EXISTS`, a header comment with the runner's constraints like `005`'s, every statement ending with its semicolon on its last line and no other line ending with one).

- [ ] **Step 1: Check the number, then write the failing tests.** `ls packages/shared/schema` must end at `012_*` (else take the next number for this file and every reference in this task). `migrate.e2e-spec.ts`: `SHAPES` gains the three tables (partition `intDiv(ledger_index, 10000000)` for the two ledger tables, `''` for `escrows`; version column `''`, `''`, `version`); `SAMPLE_ROWS` one typed row each (so "round-trips through the table" and "exactly the tables of the Table enum" cover them); new tests `it('orders object_changes by (object_type, object_id, ledger_index, tx_index) and account_object_changes by (account, object_type, role, ledger_index, tx_index, object_id)')` (`system.tables.sorting_key`) and `it('keeps the two ledger object tables on a dedup window of 1000')` (`engine_full`).
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate` → FAIL: unknown tables and enum entries.
- [ ] **Step 3: Write the migration, the enum entries, the row types, the `LEDGER_KEYED_TABLES` entries and `docs/data-model.md`.**
- [ ] **Step 4: Run them to verify they pass.** `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate ledger-writer` → PASS (the ledger-writer suite's "LEDGER_KEYED_TABLES all have a dedup window, partitioned as declared" includes the two tables).
- [ ] **Step 5: Commit.** `git add packages/shared/schema/013_ledger_objects.sql packages/shared/src/clickhouse packages/shared/src/ingest/ingest-state.ts packages/shared/test/sample-rows.ts packages/shared/test/migrate.e2e-spec.ts docs/data-model.md` — `feat(shared): migration 013 for ledger object history and the escrows aggregate`.

---

### Task 4: `ObjectChangesParser`

**Files:**
- Create: `packages/shared/src/parsers/object-changes.parser.ts`, `packages/shared/src/parsers/object-changes.parser.spec.ts`, `packages/shared/test/object-oracle.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: Task 2 `stableStringify`, `escrowId` (in tests); Task 1 cases; `deepFreeze` (`src/test-utils/deep-freeze.ts`).
- Produces (Tasks 6, 7, 9 and the API):
  ```ts
  export const TRACKED_OBJECT_TYPES = ['Escrow', 'Check', 'PayChannel', 'Delegate'] as const;
  export type TrackedObjectType = (typeof TRACKED_OBJECT_TYPES)[number];
  export const OBJECT_EVENTS: Readonly<Record<TrackedObjectType, readonly string[]>>;
  //   Escrow ['create','finish','cancel','removed','update'], Check ['create','cash','cancel','removed','update'],
  //   PayChannel ['create','fund','claim','close_request','renew','close','removed','update'], Delegate ['set','delete','removed','update']
  /** Not stored: what `fields` and `previous` leave out. */
  export const OBJECT_FIELD_EXCLUSIONS: readonly string[];  // PreviousTxnID, PreviousTxnLgrSeq, OwnerNode, DestinationNode, IssuerNode
  export const TF_RENEW = 0x00010000;
  export const TF_CLOSE = 0x00020000;
  export interface ParsedObjectChange {
    object_type: TrackedObjectType; object_id: string; action: 'created' | 'modified' | 'deleted'; event: string;
    owner: string; counterparty: string;
    fields: string; previous: string; event_fields: string;   // stableStringify; previous and event_fields '{}' when empty
  }
  export class ObjectChangesParser { parse(t: ParserTx, ctx: ParseContext): ParsedObjectChange[]; }
  ```

Rules (§2.1, §2.2): every created, modified or deleted node of a tracked type, in `AffectedNodes` order, whatever the result; a modified node without `PreviousFields` gives no row; `object_id` is the node's `LedgerIndex` upper-cased; `fields` is `NewFields` of a created node, else `FinalFields`, minus the exclusions; `owner` is `fields.Account`, `counterparty` is `fields.Destination` (Escrow, Check, PayChannel) or `fields.Authorize` (Delegate). The event is the first row of §2.2's table that matches, else `update`. `event_fields`: `create` → `{ sequence }` (`tx.Sequence`, or `tx.TicketSequence` when `Sequence` is 0 or absent); `finish` → `{ fulfillment }` when the transaction has `Fulfillment`; `cash` → `{ delivered }` from `meta.DeliveredAmount`, else `tx.Amount` (never `DeliverMin`; neither: no key); anything else `{}`. `close_request` is a modification by `PaymentChannelClaim` with `TF_CLOSE` set and `Expiration` in `FinalFields`; `renew` one with `TF_RENEW` set, `Expiration` in `PreviousFields` and not in `FinalFields`; `claim` any other modification by `PaymentChannelClaim`.

- [ ] **Step 1: Write the failing tests** (each over `deepFreeze`n input, as `amm.parser.spec.ts` does):
  ```ts
  it('escrow_create_timed: one created row, owner Account, counterparty Destination, sequence in event_fields', …);
  it('escrow_create_ticket: the TicketSequence is the sequence, and escrowId(owner, it) is the object_id', …);
  it('escrow_finish_fulfillment: a deleted finish row carrying the fulfillment', …);
  it('escrow_cancel: cancel; escrow_create_token and escrow_create_mpt: Amount kept as on the ledger in fields', …); // a synthetic MPT escrow when FINDINGS lists none
  it('check_cash_amount and check_cash_deliver_min: delivered is DeliveredAmount, else Amount, never DeliverMin', …);
  it('check_cancel_third_party_expired: cancel by an account that is neither party', …);
  it.each([['channel_fund_expiration', 'fund'], ['channel_claim', 'claim'], ['channel_close_request', 'close_request'], ['channel_renew', 'renew'],
    ['channel_close_destination', 'close'], ['channel_close_expired', 'close']])('%s is %s', …);          // channel_close_expired's result is kept as recorded (a tec allowed)
  it('delegate_set_create and delegate_set_replace are set with the new list; delegate_set_empty is delete', …);
  it('a Delegate deleted by AccountDelete is removed; an Escrow modified by AccountSet is update', …);   // synthetic metadata
  it('xahau escrow_finish_escrow_id: the deleted node is read, EscrowID changes nothing', …);
  it('a threaded node without PreviousFields, and untracked types, give no rows', …);
  it('a Batch inner transaction gives its own rows', …);                                              // delegated_batch_inner, else synthetic
  // invariants, over every transaction of every recorded set of both networks (objects, recorded, amm, account-state, path-payments, flag)
  it('an Escrow created row is at escrowId(owner, event_fields.sequence)', …);
  it('a cash row delivers what the destination’s balance changes say in that currency', …);          // BalanceChangesParser rows of the same transaction
  it("a channel row's Balance minus previous.Balance is the destination's paychannel_payout change", …);
  it('fields round-trips through JSON.parse with sorted keys and none of OBJECT_FIELD_EXCLUSIONS', …);
  it('equals the oracle on every transaction', …);                                                     // test/object-oracle.ts
  ```
  `object-oracle.ts` decides `object_type, object_id, action, event, owner, counterparty` by a table of `(type, action, TransactionType, flags) → event` written separately from the parser.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- object-changes` → FAIL: module not found.
- [ ] **Step 3: Implement the parser** (pure and synchronous; nothing of `t` modified or shared).
- [ ] **Step 4: Run them to verify they pass.** Step 2's command → PASS. Kill at least 10 hand-made mutants (an event row swapped, `TicketSequence` ignored, `DeliverMin` read, an exclusion dropped, a threaded node kept, …) and list them in the task report.
- [ ] **Step 5: Commit.** `git add packages/shared/src/parsers/object-changes.parser.ts packages/shared/src/parsers/object-changes.parser.spec.ts packages/shared/test/object-oracle.ts packages/shared/src/index.ts` — `feat(shared): the object changes parser for escrows, checks, channels and delegations`.

---

### Task 5: The fee payer in balance changes, token channels, the delegate's account row

**Files:**
- Modify: `packages/shared/src/parsers/balance-changes.parser.ts`, `balance-changes.parser.spec.ts`, `packages/shared/src/parsers/affected-accounts.parser.ts`, `affected-accounts.parser.spec.ts`, `packages/shared/src/ingest/build-rows.spec.ts`

**Interfaces:**
- Consumes: Task 2 `feePayer`; Task 1 cases.
- Produces: `BalanceChangesParser.accountRoot()` books the `transaction_cost` row (node −1) to `feePayer(t.tx)` and that account's other row is its change less the fee; `Account`'s row is its whole change. `channel()` reads `Amount` and `Balance` through `escrowValue` (`.toFixed()`), so an issued-token channel's `paychannel_*` values are token values. `AffectedAccountsParser.parse()` appends `tx.Delegate` (a classic address string) when the metadata does not name it; so the delegate always gets an `account_transactions` row (`is_initiator = 0`). `account_tx_by_sequence` stays the sender's only.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // balance-changes.parser.spec.ts
  it('charges the fee of a delegated Payment to the delegate', …);   // delegated_payment: the transaction_cost row's account is tx.Delegate, amount −Fee;
                                                                       // Account's native row is −Amount exactly; no row of Account is transaction_cost
  it('charges the fee of a delegated tec to the delegate', …);       // delegated_tec
  it('sums every currency to zero but the fee burn, delegated transactions included', …); // every recorded transaction of every set
  it("types an issued-token channel's claim with token amounts", …); // xahau channel_claim_token: paychannel_fund_final_balance is the token value text
  it("types an XRPL issued-token escrow as FINDINGS says: the sender's line at create, the destination's at finish, the issuer's rows untyped", …);
  it('leaves every balance-change snapshot unchanged', …);           // no change under __snapshots__ in this task (git diff --stat)
  // affected-accounts.parser.spec.ts
  it('lists the delegate of a delegated Payment once', …);
  it('appends the delegate a fee-free inner transaction does not name', …); // delegated_batch_inner, else synthetic: last in the list
  // build-rows.spec.ts
  it("gives the delegate an account_transactions row with is_initiator 0 and leaves account_tx_by_sequence the sender's", …);
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- balance-changes affected-accounts build-rows` → the new cases FAIL.
- [ ] **Step 3: Implement** the three changes (`accountRoot` compares the node's account with `feePayer(t.tx)` instead of `t.tx.Account`).
- [ ] **Step 4: Run them to verify they pass.** Step 2's command → PASS; `pnpm --filter @gatehub/data-api-shared test` → PASS with no snapshot written.
- [ ] **Step 5: Commit.** `git add packages/shared/src/parsers/balance-changes.parser.ts packages/shared/src/parsers/balance-changes.parser.spec.ts packages/shared/src/parsers/affected-accounts.parser.ts packages/shared/src/parsers/affected-accounts.parser.spec.ts packages/shared/src/ingest/build-rows.spec.ts` — `fix(shared): a delegated transaction's fee is the delegate's, and token channels are typed in tokens` (body: the delegate signs and pays (§2.3, decision 9); `channel()` read every amount as drops; ADR-0010 item in Task 14).

---

### Task 6: Ingest of the object rows, parser version 7

**Files:**
- Modify: `packages/shared/src/clickhouse/rows.ts` (`OBJECT_PARSER_VERSION`, `PARSER_VERSION`, the version comment), `packages/shared/src/ingest/build-rows.ts`, `build-rows.spec.ts` and its `__snapshots__`, `packages/shared/src/ingest/ledger-writer.ts`, `packages/shared/test/build-rows.e2e-spec.ts`, `packages/shared/test/ledger-writer.e2e-spec.ts`
- Modify: `apps/syncer/src/modules/prometheus/prometheus.service.ts` (+ spec), `apps/syncer/src/ingest/live-runner.ts`, `apps/syncer/src/cli/range-ingest.ts`, `apps/syncer/test/synthetic-chain.ts` (a ledger with an unclassified object change, beside its unclassified AMM pool), `apps/syncer/test/live-runner.e2e-spec.ts`, `apps/syncer/test/range-ingest.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 3 tables and rows; Task 4 `ObjectChangesParser`; Task 5's parsers.
- Produces:
  ```ts
  /** The first parser version that writes object_changes and account_object_changes, gives a transaction's Delegate its account_transactions row,
   *  books a delegated fee to the delegate and types issued-token channels in tokens. Readers gate on it, never on PARSER_VERSION. */
  export const OBJECT_PARSER_VERSION = 7;
  export const PARSER_VERSION = 7;
  // LedgerRows gains
  objectChanges: ObjectChangesRow[]; accountObjectChanges: AccountObjectChangesRow[];
  // LedgerDiagnostics and LedgerWriteResult gain
  objectsUnclassified: number;   // rows of event 'update', summed
  // PrometheusService gains
  objectsUnclassifiedTotal: Counter 'syncer_objects_unclassified_total'
  ```
  `CHILD_TABLES` gains `[Table.ObjectChanges, 'objectChanges']`, `[Table.AccountObjectChanges, 'accountObjectChanges']`. Per parsed change, `buildLedgerRows` writes one `object_changes` row (the ledger and transaction columns: `ledger_index`, `tx_index`, `tx_hash`, `close_time`, `tx_type`, `result`, `sender` = `senderOf(t)`, `delegate` = `tx.Delegate` or `''`) and two `account_object_changes` rows, `role: 'owner'` for `owner` and `role: 'counterparty'` for `counterparty` (two rows when they are the same account; none for an empty `counterparty`).

- [ ] **Step 1: Check the number, then write the failing tests.** `grep -n "PARSER_VERSION = " packages/shared/src/clickhouse/rows.ts` must show `PARSER_VERSION = 6` (else take the next number for both constants and every reference in this task).
  ```ts
  // build-rows.spec.ts, describe('ledger objects (parser version 7)')
  it('writes an EscrowCreate as one object_changes row and an owner and a counterparty account row', …);  // every column
  it('writes one account row per role when owner and counterparty are the same account', …);
  it("fills delegate from the transaction's Delegate", …);
  it('counts update rows in diagnostics.objectsUnclassified', …);    // synthetic modification
  it('stamps parser_version 7', …);
  ```
  `build-rows.e2e-spec.ts`: the objects fixtures of both networks insert into every table. `ledger-writer.e2e-spec.ts`: the objects fixtures land in both tables; after a failed write and recovery (`deleteLedgersAbove`) no `object_changes` or `account_object_changes` row is above the checkpoint. `range-ingest.e2e-spec.ts`: `--reprocess` over the objects ledgers leaves the same row count in both tables (no duplicates), and the synthetic chain's unclassified object change is counted. `prometheus.service.spec.ts`: the counter's name and help. `live-runner.e2e-spec.ts`: `syncer_objects_unclassified_total` grows by a written batch's `objectsUnclassified`, as `syncer_amm_unclassified_total` does.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- build-rows` and `pnpm --filter @gatehub/data-syncer test -- prometheus` → FAIL.
- [ ] **Step 3: Implement**, then update the snapshots with `-u` and check `git diff packages/shared/src/ingest/__snapshots__`: the only differences are `parser_version` 7 and the two new arrays. Range-ingest's end-of-run summary names the unclassified objects as it names the AMM ones.
- [ ] **Step 4: Run them to verify they pass.** Step 2's commands, `pnpm --filter @gatehub/data-api-shared test:e2e -- build-rows ledger-writer` and `pnpm --filter @gatehub/data-syncer test:e2e -- range-ingest live-runner` → PASS.
- [ ] **Step 5: Commit.** `git add packages/shared/src/clickhouse/rows.ts packages/shared/src/ingest packages/shared/test/build-rows.e2e-spec.ts packages/shared/test/ledger-writer.e2e-spec.ts apps/syncer/src/modules/prometheus apps/syncer/src/ingest/live-runner.ts apps/syncer/src/cli/range-ingest.ts apps/syncer/test/synthetic-chain.ts apps/syncer/test/live-runner.e2e-spec.ts apps/syncer/test/range-ingest.e2e-spec.ts` — `feat(shared): ingest writes object history under parser version 7` (body: a new gate, so coverage can tell the ledgers written before it).

---

### Task 7: The `escrows` job

**Files:**
- Create: `packages/shared/src/aggregate/escrows.job.ts`, `packages/shared/src/aggregate/escrows.job.spec.ts`, `packages/shared/test/escrows.job.e2e-spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: Task 3 `Table.Escrows`, `EscrowsRow`; Task 2 `mptIssuerOf`; `committedHead` (`aggregate/amm-pools.job.ts`); `dropsToNative`.
- Produces (Task 8; **D7 consumes `readEscrowed` and `Escrowed` exactly**):
  ```ts
  export const ESCROWS_STEP_LEDGERS = 1_000_000;
  export const ESCROWS_CHUNK = 500;
  export interface Escrowed { drops: string; open: number; through_ledger: number }
  export interface EscrowsStep { from: number; to: number; touched: number; written: number; removed: number; escrowed: Escrowed }
  /** The escrows row of an escrow from its newest object_changes row and its created row (pure). */
  export function escrowRowOf(newest: EscrowSource, created: EscrowSource | undefined, native: string, version: number): EscrowsRow;
  export interface EscrowSource { object_id: string; ledger_index: number; action: 'created' | 'modified' | 'deleted'; fields: string; event_fields: string }
  export function escrowsTouchedIn(ch: ClickHouseService, fromLedger: number, toLedger: number): Promise<string[]>;      // IDs with a row in (from, to]
  export function recomputeEscrows(ch: ClickHouseService, ids: readonly string[], opts: { upTo: number; native: string; signal?: AbortSignal }): Promise<{ written: number; removed: number }>;
  /** The sentinel, one read; undefined before the first run. */
  export function readEscrowed(ch: ClickHouseService): Promise<Escrowed | undefined>;
  /** One run step: (W, U] with U = max(W, min(head, W + step)); the sentinel written last, always. */
  export function runEscrowsStep(ch: ClickHouseService, opts: { native: string; step?: number; signal?: AbortSignal }): Promise<EscrowsStep>;
  /** For an agg_dirty slice: IDs touched in [min, max] and those whose newest row's last_ledger is in [min, max]. */
  export function escrowsOfLedgers(ch: ClickHouseService, min: number, max: number): Promise<string[]>;
  /** The total again and the sentinel rewritten under a newer version with the same through_ledger; undefined without a sentinel. */
  export function refreshEscrowsTotal(ch: ClickHouseService, opts: { native: string; signal?: AbortSignal }): Promise<Escrowed | undefined>;
  ```

Rules (§1.3, §4.1):
- `escrowRowOf`: `owner`, `destination` from `fields`; `sequence` = `fields.Sequence`, else the created row's `event_fields.sequence`, else `null`; the amount: drops → `currency` = native, `issuer` `''`, `amount` = `dropsToNative`, `amount_drops` = the drops; an issued token → its `currency`, `issuer`, `value`, `amount_drops` 0; an MPT → `currency` = the issuance ID upper case, `issuer` = `mptIssuerOf`, `amount` = `value`, `amount_drops` 0; `finish_after`, `cancel_after` unix seconds or `null`; `has_condition` 1 with `Condition`; `created_ledger` the created row's ledger or `null`; `last_ledger` the newest row's; `deleted` 1 when its `action` is `deleted`; `open_count`, `through_ledger` 0.
- `recomputeEscrows`, per `ESCROWS_CHUNK` IDs: read the newest row at or before `upTo` (`… WHERE object_type = 'Escrow' AND object_id IN {ids:Array(String)} AND ledger_index <= {upTo:UInt32} ORDER BY object_type, object_id, ledger_index DESC, tx_index DESC LIMIT 1 BY object_id`), the newest `created` row the same way with `AND action = 'created'`, the newest versions (`SELECT escrow_id, max(version) … GROUP BY escrow_id`) and the clock (`toUnixTimestamp64Milli(now64(3))`); insert one row per ID with a row under `max(clock, newest + 1)`; an ID with no row left gets `DELETE FROM escrows WHERE escrow_id IN {gone:Array(String)}` with `lightweight_deletes_sync = 2`.
- The total, only when a step wrote or removed something, else the previous sentinel's:
  ```sql
  SELECT count() AS open, toString(sum(amount_drops)) AS drops
    FROM (SELECT deleted, amount_drops, currency, issuer FROM escrows WHERE escrow_id != ''
           ORDER BY escrow_id, version DESC LIMIT 1 BY escrow_id)
   WHERE deleted = 0 AND issuer = '' AND currency = {native:String}
  ```
- The sentinel (`escrow_id = ''`, `amount_drops` = drops, `open_count` = open, `through_ledger` = U, every other column empty, 0 or `null`) is inserted after everything else of the step, under `max(clock, its newest version + 1)`; read with `WHERE escrow_id = '' ORDER BY version DESC LIMIT 1`.

- [ ] **Step 1: Write the failing tests.** `escrows.job.spec.ts` (pure `escrowRowOf`): a native timed escrow, a token escrow, an MPT escrow (currency = ID, issuer from the ID), a finished one (`deleted` 1), a ticketed one whose sequence comes from the created row, one without a created row (`created_ledger` null). `escrows.job.e2e-spec.ts` (a fresh database, the objects fixtures of XRPL written through `LedgerWriter`, synthetic `object_changes` rows inserted for the cases the recordings lack):
  ```ts
  it('moves the watermark a step at a time and reaches the head', …);          // step: 10 → through_ledger = min(H, W + 10) after each run
  it('keeps the total equal to a full recount of open native escrows', …);     // recount from object_changes newest rows by hand-written SQL
  it('counts native escrows only', …);                                          // token and MPT escrows: amount_drops 0, not in open
  it('writes the sentinel on a run with nothing to do', …);                     // one more sentinel row, newer version, same drops and open, no escrow row
  it('deletes an escrow whose rows a re-ingest removed', …);                    // DELETE its object_changes rows; escrowsOfLedgers + recomputeEscrows + refreshEscrowsTotal: row gone, total lower
  it('is idempotent', …);                                                       // recompute twice: the same newest rows
  it('readEscrowed is undefined before the first run', …);
  it('reads only the escrow rows of the partitions holding (W, U]', …);        // query_log read_rows of escrowsTouchedIn ≤ escrow rows there + 8192 per partition
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- escrows` and `test:e2e -- escrows` → FAIL: module not found.
- [ ] **Step 3: Implement the job.**
- [ ] **Step 4: Run them to verify they pass.** Step 2's commands → PASS.
- [ ] **Step 5: Commit.** `git add packages/shared/src/aggregate/escrows.job.ts packages/shared/src/aggregate/escrows.job.spec.ts packages/shared/test/escrows.job.e2e-spec.ts packages/shared/src/index.ts` — `feat(shared): the escrows aggregate and its sentinel` (body: D7 reads the escrowed total and its ledger from one row, written on every run).

---

### Task 8: The `escrows` runner in the aggregator

**Files:**
- Create: `apps/syncer/src/aggregator/escrows.job-runner.ts`, `escrows.job-runner.spec.ts`, `apps/syncer/test/aggregator-escrows.e2e-spec.ts`
- Modify: `apps/syncer/src/aggregator/job-context.ts` (`AggregatorJobName` gains `'escrows'`), `aggregator.service.ts` (+ `aggregator.service.spec.ts`, `aggregator.schedule.spec.ts`), `aggregator.module.ts`, `apps/syncer/src/modules/prometheus/prometheus.service.ts` (+ spec)

**Interfaces:**
- Consumes: Task 7's functions; `AggregatorJobContext`, `AggregatorTick`; `RatesService.ledgersClosedIn`; D3's `nft_state` job and hook (their place in the tick).
- Produces:
  ```ts
  export const AGGREGATOR_ESCROWS_BUDGET_MS = 2000;            // aggregator.service.ts
  export interface AggregatorEscrows { rates: RatesService; nativeCurrency: 'XRP' | 'XAH' }
  export interface EscrowsFunctions { step: typeof runEscrowsStep; ofLedgers: typeof escrowsOfLedgers; recompute: typeof recomputeEscrows;
                                      refreshTotal: typeof refreshEscrowsTotal; read: typeof readEscrowed }
  export const ESCROWS_FUNCTIONS: EscrowsFunctions;
  export class EscrowsJobRunner {
    constructor(ctx: AggregatorJobContext, escrows: AggregatorEscrows, fns: EscrowsFunctions);
    run(tick: AggregatorTick): Promise<void>;                     // at least one step; more while through_ledger < head and ctx.mayStartSet(tick, 'escrows')
    ofSlice(start: number, end: number, tick: AggregatorTick): Promise<void>;
  }
  // AggregatorOptions gains escrows?: AggregatorEscrows; escrowsFunctions?: Partial<EscrowsFunctions>
  // PrometheusService gains escrowsLagLedgers (Gauge 'syncer_escrows_lag_ledgers', head − through_ledger), escrowsOpen (Gauge 'syncer_escrows_open')
  ```
  The job `{ name: 'escrows', budgetMs: budgets.escrows }` runs every tick right after `amm_pools` and D3's `nft_state`. `ofSlice`: the slice's ledgers (`rates.ledgersClosedIn`); none, no sentinel, or a watermark below the slice's first ledger → nothing (the live run covers it); else `recompute(ofLedgers(min, max), { upTo: through_ledger })` then `refreshTotal`. `hooksOfSlice` runs it after D3's `nft_state` hook, with or without the `aggregates` option (as D3 runs its own); a failure is counted and logged as `escrows_dirty` and fails the slice. The tick order becomes `volume_live, volume_daily, amm_pools, nft_state, escrows, pair_hourly, …`. `aggregatorOptions()` passes `escrows: { rates, nativeCurrency: profile.nativeCurrency }` and logs "Escrows job on: the current state of every escrow and the escrowed total, from object_changes".

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // escrows.job-runner.spec.ts (fake functions, fake clock)
  it('moves the watermark to the head on a tick with no escrow', …);   // step called once, the gauges set (lag 0)
  it('takes steps until the head while the budget lasts', …);
  it('throws a failing step for the service to count', …);
  it('skips a slice the watermark has not reached', …);
  it('recomputes a slice at the watermark and refreshes the total', …);
  // aggregator.service.spec.ts
  it('fails the slice and keeps the range when the escrows hook fails (escrows_dirty)', …);
  // aggregator.schedule.spec.ts: the order has escrows after amm_pools and nft_state; the live volume sets are not starved with it registered
  // prometheus.service.spec.ts: the two gauges
  // aggregator-escrows.e2e-spec.ts (real ClickHouse, the objects fixtures)
  it('builds the escrows table to the head and reports lag 0', …);
  it('writes a newer sentinel every tick with no new ledger', …);
  it('recomputes the escrows of an agg_dirty range after their rows changed', …);
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- escrows aggregator prometheus` → FAIL.
- [ ] **Step 3: Implement** the runner, the option, the job, the hook, the budget and the gauges.
- [ ] **Step 4: Run them to verify they pass.** Step 2's command and `pnpm --filter @gatehub/data-syncer test:e2e -- aggregator-escrows aggregator` → PASS.
- [ ] **Step 5: Commit.** `git add apps/syncer/src/aggregator apps/syncer/src/modules/prometheus apps/syncer/test/aggregator-escrows.e2e-spec.ts` — `feat(syncer): the escrows job every tick and on agg_dirty slices`.

---

### Task 9: Status rules and response objects

**Files:**
- Create: `apps/api/src/ledger-objects/object-status.ts`, `object-status.spec.ts`, `apps/api/src/ledger-objects/object-views.ts`, `object-views.spec.ts`

**Interfaces:**
- Consumes: Task 2 `mptAmountObject`, `isMptIssuanceId`, `permissionOf`, `Permission`; Task 4 `TrackedObjectType`; `dropsToNative`; `fmtTime`.
- Produces (Tasks 10–12; E10 mirrors `object-status.ts`):
  ```ts
  // object-status.ts — times in unix seconds; `removedBy` is the deleting row's event
  export type EscrowStatus = 'pending' | 'can_be_finished' | 'can_be_cancelled' | 'finished' | 'cancelled' | 'removed';
  export type CheckStatus = 'open' | 'expired' | 'cashed' | 'cancelled' | 'removed';
  export type ChannelStatus = 'open' | 'closing' | 'closed' | 'removed';
  export function escrowStatus(o: { finishAfter?: number; cancelAfter?: number; removedBy?: string }, t: number): EscrowStatus;
  export function checkStatus(o: { expiration?: number; removedBy?: string }, t: number): CheckStatus;
  export function channelStatus(o: { expiration?: number; cancelAfter?: number; removedBy?: string }, t: number): ChannelStatus;
  // object-views.ts
  export interface ObjectRead { object_type: TrackedObjectType; object_id: string; ledger_index: number; tx_index: number; tx_hash: string; close_time: number;
    tx_type: string; result: string; sender: string; delegate: string; action: 'created' | 'modified' | 'deleted'; event: string; owner: string; counterparty: string;
    fields: Record<string, unknown>; previous: Record<string, unknown>; event_fields: Record<string, unknown> }   // JSON parsed by the service
  export type ObjectAmount = { currency: string; issuer?: string; value: string; mpt_issuance_id?: string };
  export function objectAmount(raw: unknown, native: string): ObjectAmount | undefined;
  export function rippleIso(seconds: number): string;                       // fmtTime(seconds + 946_684_800)
  export const OBJECT_REF_KEYS = ['ledger_index', 'time', 'tx_hash'];
  export const REMOVED_KEYS = ['ledger_index', 'time', 'tx_hash', 'tx_type'];
  export const EVENT_KEYS = ['event', 'ledger_index', 'time', 'tx_hash', 'tx_type', 'account', 'delegate', 'result'];
  export const ESCROW_KEYS = ['escrow_id', 'account', 'sequence', 'destination', 'amount', 'finish_after', 'cancel_after', 'condition', 'fulfillment',
    'destination_tag', 'source_tag', 'transfer_rate', 'status', 'created', 'removed'];
  export const CHECK_KEYS = ['check_id', 'account', 'sequence', 'destination', 'send_max', 'expiration', 'invoice_id', 'destination_tag', 'source_tag',
    'delivered', 'status', 'created', 'removed'];
  export const PAYMENT_CHANNEL_KEYS = ['channel_id', 'account', 'sequence', 'destination', 'amount', 'balance', 'remaining', 'settle_delay', 'public_key',
    'expiration', 'cancel_after', 'destination_tag', 'source_tag', 'status', 'opened_with', 'funds', 'claims', 'created', 'removed'];
  export const EVENT_EXTRA_KEYS = { escrow: ['amount', 'fulfillment'], check: ['send_max', 'expiration', 'delivered'],
    payment_channel: ['amount', 'balance', 'amount_change', 'balance_change', 'expiration', 'settle_delay'] };
  export const DELEGATION_KEYS = ['delegation_id', 'account', 'authorize', 'permissions', 'updated', 'created'];
  export const PERMISSION_KEYS = ['permission', 'kind', 'transaction_type'];
  export const LEDGER_OBJECT_KEYS = ['object_id', 'object_type', 'account', 'deleted', 'ledger_index'];
  export const DETAIL_BODY_KEYS = {
    escrow: ['result', 'coverage', 'ledger_index', 'close_time', 'escrow', 'history', 'history_marker'],
    check: ['result', 'coverage', 'ledger_index', 'close_time', 'check', 'history', 'history_marker'],
    payment_channel: ['result', 'coverage', 'ledger_index', 'close_time', 'payment_channel', 'history', 'history_marker'] };
  export const HISTORY_BODY_KEYS = ['result', 'coverage', 'ledger_index', 'close_time', 'count', 'marker', 'history'];
  export const DELEGATIONS_BODY_KEYS = ['result', 'coverage', 'ledger_index', 'close_time', 'count', 'marker', 'delegations'];
  export function escrowObject(newest: ObjectRead, created: ObjectRead | undefined, t: number, native: string): EscrowObject;
  export function checkObject(newest: ObjectRead, created: ObjectRead | undefined, t: number, native: string): CheckObject;
  export function paymentChannelObject(newest: ObjectRead, created: ObjectRead | undefined, counts: { funds: number; claims: number }, t: number, native: string): PaymentChannelObject;
  export function objectEvent(row: ObjectRead, native: string): ObjectEvent;    // EVENT_KEYS, then the type's extras
  export function delegationObject(newest: ObjectRead, created: ObjectRead | undefined, transactionTypes: Readonly<Record<string, number>>): DelegationObject;
  ```

Rules (§5.1–5.6): `status` per §5.2 with `t` = the answer's close time; `sequence` is `fields.Sequence`, else the created row's `event_fields.sequence`; `created` is `{ledger_index, time, tx_hash}` of the created row when there is one; `removed` is `{ledger_index, time, tx_hash, tx_type}` of the newest row when it is `deleted`; escrow `fulfillment` and check `delivered` come from the deleting row's `event_fields`; `transfer_rate`, tags and `settle_delay` are numbers; `public_key`, `condition`, `invoice_id` as on the ledger. A channel's `balance` is `fields.Balance`, zero in the channel's currency when absent (a created node omits a zero); `remaining` = `amount − balance`; `opened_with` is the created row's `Amount`. A channel event carries `amount` and `balance` after it, `amount_change` / `balance_change` when `previous` has `Amount` / `Balance` and the difference is not zero, `expiration` after it when set, `settle_delay` on `create`. Escrow events add `amount` on `create` and `fulfillment` on `finish`; check events add `send_max` and `expiration` on `create` and `delivered` on `cash`. `delegationObject`: `permissions` = `fields.Permissions[].Permission.PermissionValue` through `permissionOf` (`PERMISSION_KEYS`), `updated` = the newest row's ref, `created` the created row's.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // object-status.spec.ts (F = 1000, C = 2000, E = 3000)
  expect([999, 1000, 1001, 2000, 2001].map((t) => escrowStatus({ finishAfter: 1000, cancelAfter: 2000 }, t)))
    .toEqual(['pending', 'pending', 'can_be_finished', 'can_be_finished', 'can_be_cancelled']);
  expect([escrowStatus({ cancelAfter: 2000 }, 1), escrowStatus({}, 1)]).toEqual(['can_be_finished', 'can_be_finished']);
  expect(['finish', 'cancel', 'removed'].map((e) => escrowStatus({ finishAfter: 1000, removedBy: e }, 1))).toEqual(['finished', 'cancelled', 'removed']);
  expect([2999, 3000].map((t) => checkStatus({ expiration: 3000 }, t))).toEqual(['open', 'expired']);
  expect(['cash', 'cancel', 'removed'].map((e) => checkStatus({ removedBy: e }, 1))).toEqual(['cashed', 'cancelled', 'removed']);
  expect([channelStatus({ expiration: 9_999_999 }, 1), channelStatus({ cancelAfter: 2000 }, 1999), channelStatus({ cancelAfter: 2000 }, 2000)])
    .toEqual(['closing', 'open', 'closing']);
  expect(['close', 'removed'].map((e) => channelStatus({ removedBy: e }, 1))).toEqual(['closed', 'removed']);
  // object-views.spec.ts
  it('writes each object, event, delegation and body in its *_KEYS order, absent keys left out, never null', …);
  it('converts drops to whole units and keeps an issued-token value and a hex currency code as on the ledger', …); // '1000000000000000e-4' stays as it is
  it('writes an MPT amount as the MPT amount object', …);                         // { mpt_issuance_id, value } → mptAmountObject
  it('writes Ripple-epoch times as ISO UTC', …);                                   // 814567890 → '2025-10-23T20:51:30Z'
  it("takes a ticketed escrow's sequence from its created row", …);
  it("gives a channel zero balance before its first claim, and remaining in the channel's currency", …); // XRP and an issued token
  it('gives a channel event amount_change and balance_change only when not zero', …);
  it('maps permissions, an unknown value as its number', …);
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- object-status object-views` → FAIL: modules not found.
- [ ] **Step 3: Implement both modules** (pure; `compact` drops `undefined` keys).
- [ ] **Step 4: Run them to verify they pass.** Step 2's command → PASS.
- [ ] **Step 5: Commit.** `git add apps/api/src/ledger-objects/object-status.ts apps/api/src/ledger-objects/object-status.spec.ts apps/api/src/ledger-objects/object-views.ts apps/api/src/ledger-objects/object-views.spec.ts` — `feat(api): status rules and response objects of escrows, checks, channels and delegations`.

---

### Task 10: The ledger objects service, coverage, and the escrow routes

**Files:**
- Create: `apps/api/src/ledger-objects/ledger-objects.module.ts`, `ledger-objects.service.ts`, `escrows.controller.ts`, `apps/api/src/accounts/account-escrow.controller.ts`, `apps/api/test/ledger-objects.e2e-spec.ts`, `apps/api/test/support/objects.ts`, `apps/api/src/common/coverage-features.spec.ts` (if D3 left none)
- Modify: `apps/api/src/common/coverage-features.ts` (D3's registry: four entries), `apps/api/src/app.module.ts` (`ENDPOINT_MODULES`; `app.module.spec.ts` keeps `NotFoundModule` last), `apps/api/src/accounts/accounts.module.ts` (imports `LedgerObjectsModule`, the new controller), `apps/api/src/common/ledger-range.service.ts` (+ spec: `latestWithTime`), `apps/api/test/support/fixtures.ts` (seeds), `apps/api/test/paged-reads.e2e-spec.ts`, `docs/api-reference.md`

**Interfaces:**
- Consumes: Tasks 3, 6, 9; D3 `COVERAGE_FEATURES`, `FeatureCoverageService`, `Coverage`; `readDistinctPage`, `encodeMarker`, `decodeMarker`, `keysetClause`, `setLinkHeader`, `limitParam`, `bool`, `@RippleController`, `@RippleRoute`, `@Csv`, `wantsCsv`, `badRequest`, `notFound`, `NETWORK_PROFILE`.
- Produces (D7 asks `coverage('escrows')`):
  ```ts
  // coverage-features.ts: COVERAGE_FEATURES gains, each { parserVersion: OBJECT_PARSER_VERSION, startOf }
  escrows:          startOf: (p) => p.family === 'xahau' ? { kind: 'first_ledger' } : { kind: 'amendment', amendment: 'Escrow' },
  payment_channels: startOf: (p) => p.family === 'xahau' ? { kind: 'first_ledger' } : { kind: 'amendment', amendment: 'PayChan' },
  checks:           startOf: (p) => p.family === 'xahau' ? { kind: 'first_ledger' } : { kind: 'amendment', amendment: 'Checks' },
  delegations:      startOf: (p) => p.hasDelegation ? { kind: 'amendment', amendment: 'PermissionDelegationV1_1' } : { kind: 'unavailable' },
  // ledger-range.service.ts
  latestWithTime(): Promise<{ ledger_index: number; close_time: number } | undefined>;  // the newest ledgers row and its close time, one read
  // ledger-objects.service.ts
  export type ObjectKind = 'escrow' | 'check' | 'payment_channel';
  export const OBJECT_TYPE_OF: Record<ObjectKind, 'Escrow' | 'Check' | 'PayChannel'>;
  export const FEATURE_OF: Record<ObjectKind, CoverageFeatureName>;  // escrow → escrows, check → checks, payment_channel → payment_channels
  export const NOT_FOUND_OF: Record<ObjectKind, string>;        // 'escrow not found', 'check not found', 'payment channel not found'
  export const DETAIL_EVENTS = 50;
  export interface AsOf { ledger_index: number; close_time: number }
  export interface ObjectDetail { asOf: AsOf; rows: ObjectRead[] /* newest first, at most 51 */; created?: ObjectRead; counts?: { funds: number; claims: number } }
  export interface ObjectHistory { asOf: AsOf; rows: ObjectRead[]; created?: ObjectRead; marker?: string }
  @Injectable() export class LedgerObjectsService {
    detail(kind: ObjectKind, id: string): Promise<ObjectDetail>;           // throws notFound(NOT_FOUND_OF[kind])
    history(kind: ObjectKind, id: string, o: { descending: boolean; limit: number; marker?: string }): Promise<ObjectHistory>;
  }
  // test/support/objects.ts
  export function objectRow(o: Partial<ObjectChangesRow> & Pick<ObjectChangesRow, 'object_type' | 'object_id' | 'ledger_index'>): ObjectChangesRow;
  export function seedObjects(h: Harness, rows: ObjectChangesRow[], head: { ledger_index: number; close_time: number }): Promise<void>; // + a ledgers row for H
  ```
  `SeedName` gains `'xrpl-objects'` and `'xahau-objects'` (Task 1's directories). `LedgerObjectsModule` exports `LedgerObjectsService`.

Reads (§3; every one bound, `H` from `latestWithTime()`): the page is `readDistinctPage` over `object_changes` with `where` `object_type = {type:String}`, `object_id = {id:String}`, `ledger_index <= {H:UInt32}` and the keyset clause of a marker, `orderBy` `['object_type', 'object_id', 'ledger_index', 'tx_index']`, `unique` `['ledger_index', 'tx_index']`; the detail reads `DETAIL_EVENTS + 1` newest first; no row → 404. `created`: the page's `created` row, else the newest row of the prefix `AND action = 'created'` (`LIMIT 1`). History reads, side by side, the page, `created`, and (with a marker) a one-row existence read of the prefix: no row at all → 404; a page past the end is `count: 0`. Markers are `encodeMarker([ledger_index, tx_index])` (`UInt32, UInt32`), one route and direction each; the detail's `history_marker` is the 50th row's, for `/{id}/history?descending=true&marker=…`.

Escrow routes (§5.3): `GET /v2/escrows/:id`, `GET /v2/escrows/:id/history`, `GET /v2/accounts/:address/escrows/:sequence` (`isValidClassicAddress` else 400 `invalid ripple address`; `/^\d+$/` and ≤ 4294967295 else 400 `invalid sequence number`; then exactly as `/v2/escrows/{escrowId(address, sequence)}`). Messages: 400 `invalid escrow id`, 404 `escrow not found`, 500 `unable to retrieve escrow` / `unable to retrieve escrow history`, 400 `invalid marker`; history parameters `descending` (default false), `limit` (200, max 1000), `marker`, `format=csv` (`<id> - escrow history.csv`, rows flattened), `Link`. `coverage` = `itemCoverage('escrows', created?.ledger_index)` on the detail and the history.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // coverage-features.spec.ts: the four entries' startOf over the four profiles
  expect(NETWORK_NAMES.map((n) => COVERAGE_FEATURES.escrows.startOf(getNetworkProfile(n)))).toEqual([{ kind: 'amendment', amendment: 'Escrow' },
    { kind: 'first_ledger' }, { kind: 'amendment', amendment: 'Escrow' }, { kind: 'first_ledger' }]);           // payment_channels (PayChan) and checks (Checks) alike
  expect(NETWORK_NAMES.map((n) => COVERAGE_FEATURES.delegations.startOf(getNetworkProfile(n)).kind)).toEqual(['amendment', 'unavailable', 'amendment', 'unavailable']);
  expect(Object.values(pick(COVERAGE_FEATURES, D5_FEATURES)).map((f) => f.parserVersion)).toEqual([7, 7, 7, 7]);
  // feature-coverage.service.spec.ts (D3's, extended with a D5 case each):
  it('xahau escrows are complete from ledger 1 and xrpl escrows from 28685313', …);   // through D3's first_ledger and amendment rules
  it('an xrpl-testnet escrow is complete false without an indexed EnableAmendment', …);
  // ledger-objects.e2e-spec.ts (seed xrpl-objects + synthetic rows; xahau-objects in a second harness)
  it('serves an open escrow in ESCROW_KEYS order with its newest events and coverage first', …);
  it('serves a finished escrow with removed, fulfillment and status finished', …);
  it('evaluates status at the close time of H', …);                  // a synthetic escrow: H's close time = FinishAfter → pending; one more ledger → can_be_finished
  it('answers an escrow created before the coverage with complete false and no created', …);
  it('serves the same escrow at /v2/accounts/{owner}/escrows/{sequence}', …);  // escrow_create_ticket by its TicketSequence too
  it('pages history oldest first and newest first; the pages concatenate to the whole list', …);
  it("continues the detail's history_marker at /history?descending=true", …);
  it('serves history as CSV with Link', …);
  it.each([['/v2/escrows/XYZ', 400, 'invalid escrow id'], ['/v2/escrows/<64 hex unknown>', 404, 'escrow not found'],
    ['/v2/escrows/<id>/history?marker=%%', 400, 'invalid marker'], ['/v2/accounts/<X-address>/escrows/5', 400, 'invalid ripple address'],
    ['/v2/accounts/<A>/escrows/4294967296', 400, 'invalid sequence number']])('%s → %i %s', …);
  it('answers a lower-case id in upper case', …);
  it('serves a Xahau XAH escrow and an issued-token escrow with its issuer', …);
  it('answers 401 without a key', …);
  // paged-reads.e2e-spec.ts: the detail page and a 201-row history page of one object over the bulk of four parts read about a granule per part
  // (readsOf), and expectBoundedInOrderRead holds for their inner reads; the creation read is the object's prefix
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- coverage-features feature-coverage ledger-range` and `test:e2e -- ledger-objects paged-reads` → FAIL.
- [ ] **Step 3: Implement** the four registry entries, the module, the service, the two controllers, `latestWithTime`, the seeds; write the API reference's "Ledger objects" section (conventions of §5.1, the status table of §5.2) and its escrow subsections from real e2e answers, each with a line "Keys of <object>, in order: `a`, `b?`, …" for every `*_KEYS` it uses.
- [ ] **Step 4: Run them to verify they pass.** Step 2's commands → PASS.
- [ ] **Step 5: Commit.** `git add apps/api/src/common/coverage-features.ts apps/api/src/common/coverage-features.spec.ts apps/api/src/common/feature-coverage.service.spec.ts apps/api/src/ledger-objects apps/api/src/accounts/account-escrow.controller.ts apps/api/src/accounts/accounts.module.ts apps/api/src/app.module.ts apps/api/src/common/ledger-range.service.ts apps/api/src/common/ledger-range.service.spec.ts apps/api/test/ledger-objects.e2e-spec.ts apps/api/test/support apps/api/test/paged-reads.e2e-spec.ts docs/api-reference.md` — `feat(api): /v2/escrows/{id}, its history, and an escrow by owner and sequence`.

---

### Task 11: Check and payment channel routes

**Files:**
- Create: `apps/api/src/ledger-objects/checks.controller.ts`, `payment-channels.controller.ts`
- Modify: `apps/api/src/ledger-objects/ledger-objects.service.ts` (the channel counts), `ledger-objects.module.ts`, `apps/api/test/ledger-objects.e2e-spec.ts`, `apps/api/test/paged-reads.e2e-spec.ts`, `docs/api-reference.md`

**Interfaces:**
- Consumes: Task 10's service and patterns; Task 9's objects.
- Produces: `GET /v2/checks/:id[/history]` (400 `invalid check id`, 404 `check not found`, 500 `unable to retrieve check` / `unable to retrieve check history`, CSV `<id> - check history.csv`); `GET /v2/payment_channels/:id[/history]` (400 `invalid channel id`, 404 `payment channel not found`, 500 `unable to retrieve payment channel` / `unable to retrieve payment channel history`, CSV `<id> - payment channel history.csv`). `detail('payment_channel', …)` fills `counts` with one read over the object's prefix:
  ```sql
  SELECT countIf(event = 'fund') AS funds, countIf(JSONHas(previous, 'Balance')) AS claims
    FROM (SELECT event, previous FROM object_changes
           WHERE object_type = 'PayChannel' AND object_id = {id:String} AND ledger_index <= {H:UInt32}
           ORDER BY object_type, object_id, ledger_index, tx_index
           LIMIT 1 BY ledger_index, tx_index)
  ```

- [ ] **Step 1: Write the failing tests** (`ledger-objects.e2e-spec.ts`):
  ```ts
  it('serves an open check, a cashed one with delivered from DeliveredAmount, and an expired one still in the ledger', …);
  it('serves a check cancelled by a third party after its expiration', …);
  it('serves an open channel, a closing one (expiration set; CancelAfter passed) and a closed one', …);
  it('a channel with 1,200 events: detail, marker, counts and creation', …);  // synthetic: 1 create, 3 funds, 1,196 claims → funds 3, claims 1,196,
                                                                            // opened_with the create's Amount, created present, 50 events + history_marker
  it('pages of a 1,200-event history concatenate both ways', …);
  it('serves a Xahau issued-token channel in token amounts', …);
  it.each([/* each route's 400, 404 and marker error */])('%s → %i %s', …);
  // paged-reads.e2e-spec.ts: the counts read is the object's prefix (read_rows ≤ its rows + a granule per partition)
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test:e2e -- ledger-objects paged-reads` → the new cases FAIL.
- [ ] **Step 3: Implement** the two controllers and the counts; write their reference subsections from real e2e answers with their key lines.
- [ ] **Step 4: Run them to verify they pass.** Step 2's command → PASS.
- [ ] **Step 5: Commit.** `git add apps/api/src/ledger-objects apps/api/test/ledger-objects.e2e-spec.ts apps/api/test/paged-reads.e2e-spec.ts docs/api-reference.md` — `feat(api): /v2/checks/{id} and /v2/payment_channels/{id} with their history`.

---

### Task 12: The ledger object lookup and an account's delegations

**Files:**
- Create: `apps/api/src/ledger-objects/ledger-objects.controller.ts`, `apps/api/src/accounts/account-delegations.controller.ts`, `apps/api/src/accounts/delegations.service.ts`, `apps/api/test/delegations.e2e-spec.ts`
- Modify: `apps/api/src/ledger-objects/ledger-objects.service.ts` (`lookup`), `ledger-objects.module.ts`, `apps/api/src/accounts/accounts.module.ts`, `apps/api/test/ledger-objects.e2e-spec.ts`, `apps/api/test/paged-reads.e2e-spec.ts`, `docs/api-reference.md`

**Interfaces:**
- Consumes: Tasks 2 (`transactionTypesOf`), 9, 10.
- Produces:
  ```ts
  lookup(id: string): Promise<{ object_id: string; object_type: TrackedObjectType; account: string; deleted: boolean; ledger_index: number }>; // 404 'ledger object not found'
  export const DELEGATION_IDS_CAP = 10_000;
  export type DelegationDirection = 'given' | 'held';
  @Injectable() export class DelegationsService {
    page(address: string, o: { direction: DelegationDirection; limit: number; marker?: string }): Promise<{ asOf: AsOf; rows: DelegationObject[]; marker?: string }>;
  }
  ```
  `GET /v2/ledger_objects/:id` → `{ result, ledger_object }` (`LEDGER_OBJECT_KEYS`), from one read `object_type IN {types:Array(String)} AND object_id = {id:String} AND ledger_index <= {H:UInt32}` newest first `LIMIT 1`; no `coverage`, `ledger_index` or `close_time` keys; 400 `invalid ledger object id`, 404 `ledger object not found`, 500 `unable to retrieve ledger object`. `GET /v2/accounts/:address/delegations` (§5.6): checks in the order address (`invalid ripple address`), `direction` (`given` default, `held`; else `invalid direction`), `limit` (200, max 1000), `marker` (`[ledger_index, tx_index, delegation_id]`, `UInt32, UInt32, String`; `invalid marker`); `format=csv` (`<address> - delegations given.csv` / `… held.csv`; `permissions` one cell of names separated by a space). When `isAvailable('delegations')` is false (Xahau, Xahau Testnet): the empty list and `coverage` = `coverage('delegations')` (D3's `unavailable`: `complete: true`), no read of the two tables. Otherwise: the account's IDs from `account_object_changes` (`account = {a} AND object_type = 'Delegate' AND role = {role} AND ledger_index <= {H}`, distinct, at most `DELEGATION_IDS_CAP + 1`: more answers 500 `unable to retrieve delegations` and logs the account), their newest rows and newest `created` rows (`object_type = 'Delegate' AND object_id IN {ids}`, `LIMIT 1 BY object_id`), `deleted` dropped, sorted by `updated` newest first then `delegation_id`, paged in memory after the marker; `coverage` = `coverage('delegations')`. 500 `unable to retrieve delegations`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // ledger-objects.e2e-spec.ts
  it('looks up an escrow, a check, a channel and a Delegate by ID, a removed one with deleted true', …);
  it('answers ledger_objects with no coverage key', …);
  it.each([['/v2/ledger_objects/abc', 400, 'invalid ledger object id'], ['/v2/ledger_objects/<64 hex unknown>', 404, 'ledger object not found']])(…);
  // delegations.e2e-spec.ts (xrpl-objects seed)
  it('lists the delegations an account gave and those it holds', …);
  it('shows a replaced list as its newest permissions and drops an emptied one', …);   // delegate_set_replace, delegate_set_empty
  it('keeps the created of the current entry after a delete and a new DelegateSet', …);  // synthetic: the same ID re-created
  it('pages by marker in the order updated newest first, then delegation_id', …);
  it('serves CSV with permissions in one cell', …);
  it("answers Xahau's delegations empty and complete without a read", …);              // query_log: no read of object_changes or account_object_changes
  it.each([/* X-address, direction=x, marker=%% */])('%s → 400 %s', …);
  it('answers 500 past DELEGATION_IDS_CAP', …);                                         // a synthetic account with 10,001 Delegate IDs in account_object_changes
  // paged-reads.e2e-spec.ts: the delegations reads are the account's prefix of account_object_changes and object_id IN on object_changes
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test:e2e -- ledger-objects delegations paged-reads` → FAIL.
- [ ] **Step 3: Implement** the lookup, the service and the two controllers; write their reference subsections (under "Ledger objects" and under Accounts) from real e2e answers with their key lines.
- [ ] **Step 4: Run them to verify they pass.** Step 2's command → PASS.
- [ ] **Step 5: Commit.** `git add apps/api/src/ledger-objects apps/api/src/accounts apps/api/test/ledger-objects.e2e-spec.ts apps/api/test/delegations.e2e-spec.ts apps/api/test/paged-reads.e2e-spec.ts docs/api-reference.md` — `feat(api): /v2/ledger_objects/{id} and /v2/accounts/{address}/delegations`.

---

### Task 13: The account transactions CSV: the delegate and the fee payer

**Files:**
- Modify: `apps/api/src/accounts/transaction-summary.ts`, `apps/api/test/account-transactions.e2e-spec.ts` (both CSV headers and the rows), `docs/api-reference.md` (the CSV row of `/v2/accounts/{address}/transactions`)
- Create: `apps/api/src/accounts/transaction-summary.spec.ts`

**Interfaces:**
- Consumes: Task 2 `feePayer`; Task 6's ingest (a delegate is listed under its own account).
- Produces: `TransactionSummary` gains `delegate: string | null` as its **last** column; `fee` is set on the row of `account === feePayer(tx)` (whole units), else `null`. The JSON list and the PDF columns are unchanged.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // transaction-summary.spec.ts (rows built from the delegated_payment fixture)
  it("puts the fee on the delegate's row and names the delegate last", …);  // delegate's row: initiator false, fee set, delegate = D
  it("leaves the sender's fee empty when a delegate paid it", …);             // sender's row: initiator true, fee null, delegate = D
  it('keeps an undelegated row as it was, with an empty delegate', …);
  // account-transactions.e2e-spec.ts: both expected headers end with ,"delegate"; each row ends with ,"" (and the delegated case with the delegate)
  ```
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- transaction-summary` and `test:e2e -- account-transactions` → FAIL.
- [ ] **Step 3: Implement** and update the reference's CSV columns and its fee rule.
- [ ] **Step 4: Run them to verify they pass.** Step 2's commands → PASS; `pnpm --filter @gatehub/data-exporter test` → PASS (the PDF columns are unchanged).
- [ ] **Step 5: Commit.** `git add apps/api/src/accounts/transaction-summary.ts apps/api/src/accounts/transaction-summary.spec.ts apps/api/test/account-transactions.e2e-spec.ts docs/api-reference.md` — `feat(api): the account transactions CSV names the delegate and books the fee to its payer`.

---

### Task 14: Reference check, ADRs, OpenAPI, the remaining docs and the rollout

**Files:**
- Create: `apps/api/src/ledger-objects/api-reference.spec.ts`, `docs/adr/0018-ledger-object-history.md`
- Modify: `docs/api-reference.md` (Compatibility: the new routes among the extras; the account escrow and channel lists still 404), `docs/adr/0010-ripple-v2-wire-compatibility.md` ("Amendment 7 (2026-10-24): ledger objects and delegation", and its status line), `docs/adr/README.md`, `docs/openapi.yaml` (regenerated), `docs/syncer.md` (the parser, the `escrows` job, its `agg_dirty` hook, the gauges and the counter), `docs/backfill.md` ("Ledger objects and delegation re-ingest"), `docs/operations.md` (the gauges, the re-ingest), `docs/observability.md` (the two gauges, the counter, an alert `syncer_escrows_lag_ledgers > 1000` for 15 min), `docs/architecture.md` (the module list), `README.md` (the endpoint table)

**Interfaces:**
- Consumes: every `*_KEYS` constant of Task 9; everything above.
- Produces (for E10): the built "Ledger objects" section of `docs/api-reference.md` and `docs/openapi.yaml` at this task's commit; report that commit's hash for E10 to pin.

ADR-0018 (Context, Decision, Consequences, short): one generic ledger table for the history of escrows, checks, payment channels and delegations, and its account index with `role`; state read at query time (exact, no aggregator lag); `escrows` the only aggregate, for D7's total, committed by its sentinel; events from the metadata; D3's coverage per object type and per object; the delegated fee fix and its re-ingest; Xahau's coverage without amendments (Ruling 1). ADR-0010 Amendment 7 items (numbered after the highest item in the file): the seven new routes as GateHub extras; the CSV's `delegate` column and `fee` on the fee payer's row; the delegated `transaction_cost` row in `balance_changes` (a fix, from the re-ingest on); item 7 kept (`/v2/accounts/{address}/{escrows,payment_channels,checks}` still 404).

- [ ] **Step 1: Check the numbers, then write the failing test.** `ls docs/adr` must end at `0017-*` and ADR-0010's status line at "Amendment 6" (else take the next numbers). `api-reference.spec.ts` reads `docs/api-reference.md`, takes each line ``Keys of <object>, in order: `a`, `b?`, …`` of the "Ledger objects" section and the delegations subsection, and asserts, for a fixed map (`an escrow` → `ESCROW_KEYS`, `a check` → `CHECK_KEYS`, `a payment channel` → `PAYMENT_CHANNEL_KEYS`, `an event` → `EVENT_KEYS`, `a delegation` → `DELEGATION_KEYS`, `a permission` → `PERMISSION_KEYS`, `a ledger object` → `LEDGER_OBJECT_KEYS`, the three detail bodies, the history body, the delegations body), that the names with `?` stripped equal the constant and that every constant has its line.
- [ ] **Step 2: Run it.** `pnpm --filter @gatehub/data-api-service test -- api-reference` → a drifted or missing line FAILS; fix the reference (never the constant) until it passes.
- [ ] **Step 3: Write the ADRs and the docs; regenerate `docs/openapi.yaml`** with `docs/development.md` §8 (keep its header comment). `docs/backfill.md` gets the commands of the rollout below and the coverage query `SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 7`.
- [ ] **Step 4: Run the whole suite.** `pnpm build`, `pnpm test`, `pnpm --filter @gatehub/data-api-shared test:e2e`, `pnpm --filter @gatehub/data-api-service test:e2e`, `pnpm --filter @gatehub/data-syncer test:e2e` → exit 0; `git diff --stat docs/openapi.yaml` shows the seven new paths.
- [ ] **Step 5: Commit.** `git add apps/api/src/ledger-objects/api-reference.spec.ts docs README.md` — `docs: ledger objects and delegation reference, ADR-0018 and the rollout`.

**What the owner does to deploy** (put in the hand-back, and in `docs/operations.md`):
1. Apply migration `013` on each network database (`pnpm ch:migrate`) before the syncer and the API of this release: the writer inserts into the two new tables on every ledger.
2. Deploy the syncer, then the API. From the deploy ledger every ledger has object rows, the delegate's account rows and the fixed fee rows; the `escrows` job builds its table in steps of 1,000,000 ledgers until `syncer_escrows_lag_ledgers` is a few ledgers.
3. On XRPL: `range-ingest --from 107524865 --to <deploy ledger> --reprocess` (about 200,000 ledgers; hours on Ripple's full-history node). `agg_dirty` carries the rewrite into the rollups and the escrows. Delegation coverage is then `complete: true`.
4. Escrows, checks and channels stay `complete: false` until the history backfill (ADR-0015's load from 32,570, or one reprocess after the program's last parser version) writes every ledger from 28,685,313 on XRPL and from Xahau's first ledger with parser version 7 or later.
5. The explorer's `LEDGER_OBJECTS` goes on in an environment once this API serves §5 there on both networks; `DELEGATION` once step 3 is done there (in the sandbox once the routes answer: its coverage is never complete).

---

## Rulings

1. **Xahau's coverage takes no amendment** (spec §1.4 and decision 14 against the amendments code). Xahau's `Escrow` and `PayChan` are `retired`, and the amendments assembly reports `enabled` for a retired name only when the ledger's `Amendments` object lists it (`amendment-status.ts`, D1 spec 2.7), which on Xahau it does not; a genesis ledger added to `config/amendments/xahau.json` would never reach D3's rule, so the two features would stay `complete: false` forever. On Xahau the three object features are D3's case of a feature without an amendment, whose start is `NetworkProfile.firstLedger`, Xahau's first ledger: the same E the spec intends ("on from genesis"). `xahau.json` is not edited; FINDINGS (5) records what Xahau's `Amendments` object lists.
2. **`readEscrowed(ch)` answers `undefined` before the first run** (§4.3 types it as `Escrowed`). D7 needs to tell "no sentinel yet" from a total of zero (D7 §4: the cycle waits).
3. **Coverage is four entries of D3's registry.** D5 adds `escrows`, `payment_channels`, `checks` and `delegations` to `COVERAGE_FEATURES` (D3 plan Ruling 4) and uses `coverage`, `itemCoverage` and `isAvailable`; `delegations` is `unavailable` where `hasDelegation` is false, D3's rule for a feature a network cannot have. D7 asks `coverage('escrows')`.
4. **A `Delegate` entry's `created` is its newest `created` row.** A Delegate's ID is its two accounts, so an entry deleted and set again reuses it; the current entry's creation is the newest one.
5. **The sentinel is written after every step**, not once per run, so a run of many steps (a first run over all history) keeps its progress if it stops; every run makes at least one step, so the watermark follows the head on every run (§4.1 step 5).
6. **The escrow-by-sequence route checks the address** (`invalid ripple address`), unlike `/transactions/{sequence}`, because the ID is computed from it.
7. **`pnpm lint` is not run** (consistency pass): the repository has no ESLint configuration (`docs/development.md` §4; D-env's Global Constraints), so `eslint --fix` fails; the checks before a commit and at the end are `pnpm format`, `pnpm build`, `pnpm test` and the `test:e2e` suites.
