# Xahau-native features: hooks, rewards, import, remit, cron, remarks: design

Date: 2026-10-17. Status: proposed. This is family 5 of `2026-10-17-amendments-roadmap.md`, whose shared rules are binding. It uses:
- the URIToken events of family 2;
- the generic `object_changes` table of family 4.

## Scope (decided by the user)

| Part | Amendments (enabled on Xahau mainnet) | What it gets |
|---|---|---|
| A. Hooks | Hooks, HooksUpdate1, HookCanEmit, ExtendedHookState, fixHookAPI20251128 and related fixes | Hook installs, updates and deletes per account; hook definitions; per-transaction hook executions (hook, result, return code and string, emitted transactions); lists per account and per hook; per-hook daily stats |
| B. Rewards | XahauGenesis, BalanceRewards, IOURewardClaim, fixRewardClaimFlags | `ClaimReward` claims and `GenesisMint` payouts, reward volume and daily stats |
| C. Import | Import, fixImportIssuer, fixReduceImport | Burn-to-mint imports from XRPL: imported amount, source account and transaction; import volume and daily stats |
| D. Remit, Cron, Remarks | Remit, Cron (+ fixCronStacking), Remarks | Remit as payments (several amounts and URITokens in one transaction), scheduled Cron jobs and their runs, and Remarks on objects |

## How it looks on the ledger

Checked in `packages/shared/test/fixtures/xahau/recorded`. Task 1's `FINDINGS.md` must confirm the rest.

- **Hook executions.** Transaction metadata can carry `HookExecutions`: a list of `HookExecution` entries, each with `HookAccount`, `HookHash`, `HookExecutionIndex`, `HookResult`, `HookReturnCode`, `HookReturnString` (hex), `HookInstructionCount`, `HookEmitCount`, `HookStateChangeCount` and `Flags`. 170 of 364 recorded transactions carry them.
- **Hook emissions.** Metadata can also carry `HookEmissions`: entries with `EmittedTxnID`, `EmitNonce`, `HookAccount` and `HookHash`.
- **Emitted transactions** appear in a later ledger. They carry `EmitDetails`: `EmitParentTxnID`, `EmitHookHash`, `EmitGeneration`, `EmitBurden`, `EmitNonce` and `EmitCallback`.
- **Installing hooks.** `SetHook` carries `Hooks`: up to 10 positions, each a `Hook` with `CreateCode` or `HookHash`, `HookNamespace`, `HookOn`, `HookApiVersion`, `HookParameters`, `HookGrants` and `Flags` (override, namespace delete, collect).
  - The account's `Hook` object lists the installed `HookHash`es by position.
  - A `HookDefinition` object, keyed by `HookHash`, holds the code and settings, plus a `ReferenceCount`.
- **Hook results.** The `HookResult` values to confirm are 3 = accept, 2 = rollback and 1 = wasm error.
- **Rewards.** `ClaimReward` has `Account`, `Issuer` (the genesis account) and `Flags` (opt-out). A genesis hook then emits a `GenesisMint` transaction with `GenesisMints`, a list of `{Destination, Amount}`, plus `EmitDetails` that link back to the claim.
- **Import.** `Import` carries a `Blob` (hex JSON with the XRPL ledger, the transaction and its metadata, a proof and validations). The XAH minted to `Account` shows up as that account's `AccountRoot` balance delta. Its `AccountRoot` may be created by the import.
- **Remit.** `Remit` carries `Destination`, `Amounts` (a list of `AmountEntry.Amount`), optionally `URITokenIDs`, `MintURIToken`, `Inform`, `Blob`, `InvoiceID` and `DestinationTag`.
- **Cron.** `CronSet` (`StartTime`, `RepeatCount`, `DelaySeconds`, `Flags` with unset) creates or updates a `Cron` object. A `Cron` pseudo-transaction (`Owner`, `LedgerSequence`) runs the owner's hook at the scheduled time.
- **Remarks.** `SetRemarks` carries `ObjectID` and `Remarks`, a list of `Remark` entries with `RemarkName`, an optional `RemarkValue` and `Flags` (immutable).

## 1. Storage

### Part A: hooks

| Table | Kind | ORDER BY | Holds |
|---|---|---|---|
| `hook_executions` | ledger, P6 | `(ledger_index, tx_index, execution_index)` | Every `HookExecution`. Columns: `hook_account`, `hook_hash`, `result` (`accept`, `rollback`, `error`, `unknown`), `result_raw`, `return_code` (Int64), `return_string` (hex), `return_text` (printable ASCII, else empty), `instructions`, `emit_count`, `state_changes`, `flags` (strong/weak/callback/again as named columns), `tx_hash`, `tx_type`, `tx_account` and `close_time`. |
| `hook_executions_by_hook` | ledger, P7 | `(hook_hash, ledger_index, tx_index, execution_index)` | A narrow index. |
| `account_hook_executions` | ledger, P7 | `(hook_account, ledger_index, tx_index, execution_index)` | A narrow index. |
| `hook_emissions` | ledger, P6 | `(ledger_index, tx_index, emission_index)` | Columns: `emitted_txn_id`, `hook_account`, `hook_hash`, `emit_nonce`. |
| `hook_installs` | ledger, P7 | `(account, ledger_index, tx_index, position)` | One row per `SetHook` position entry that changed something. Columns: `action` (`install`, `update`, `delete`, `namespace_delete`, `noop`), `hook_hash`, `namespace`, `hook_on`, `api_version`, `parameters` (JSON), `grants` (JSON) and `flags`. The resulting position state is taken from the account's `Hook` object diff. |
| `hook_installs_by_hook` | ledger, P7 | `(hook_hash, ledger_index, tx_index, account, position)` | A narrow index. |

Hook definitions are tracked as `HookDefinition` in the `object_changes` table of family 4. The `fields` JSON drops `CreateCode` and adds `code_size` (the byte length). Account `Hook` objects are tracked as `Hook`.

| Aggregate | ORDER BY | Holds |
|---|---|---|
| `hooks` | `hook_hash` | The definition summary: `created_ledger`, `creator`, `api_version`, `namespace`, `hook_on`, `fee`, `code_size` and `reference_count`. Plus totals: `executions`, `accepts`, `rollbacks`, `errors`, `emits`, `last_execution_ledger` and `version`. |
| `hook_daily` | `(hook_hash, day)` | `executions`, `accepts`, `rollbacks`, `errors`, `emits`, `unique_tx_accounts`, `config_version` and `version`. |

### Part B: rewards

| Table | Kind | ORDER BY | Holds |
|---|---|---|---|
| `reward_claims` | ledger, P7 | `(account, ledger_index, tx_index)` | `ClaimReward` rows: `issuer`, `opt_out`, `tx_hash`, `close_time`. |
| `genesis_mints` | ledger, P6 | `(ledger_index, tx_index, mint_index)` | One row per `GenesisMints` entry. Columns: `destination`, `amount` (drops or IOU), `parent_tx_hash` (from `EmitDetails`), `emit_hook_hash`, `tx_hash`. |
| `account_genesis_mints` | ledger, P7 | `(destination, ledger_index, tx_index, mint_index)` | A narrow index. |

| Aggregate | ORDER BY | Holds |
|---|---|---|
| `reward_daily` | `day` | `claims`, `claimers`, `mints`, `minted_native`, `reward_minted_native` (mints whose parent is a `ClaimReward`), `config_version`, `version`. |

Volume adds the metric `reward_volume`. Its components are `rewards` (mints whose parent is a `ClaimReward`) and `other_mints`, and it uses the live periods day/7day/30day.

### Part C: import

| Table | Kind | ORDER BY | Holds |
|---|---|---|---|
| `imports` | ledger, P6 | `(ledger_index, tx_index)` | Columns: `account`, `kind` (`b2m`, `key_import`, `account_import` from FINDINGS), `xrpl_tx_hash`, `xrpl_account`, `xrpl_ledger`, `xrpl_tx_type`, `burned` (XRPL drops), `minted` (the Xahau `AccountRoot` delta, in drops), `account_created` (UInt8), `issuer`, `tx_hash`, `close_time`. |
| `account_imports` | ledger, P7 | `(account, ledger_index, tx_index)` | A narrow index. |

| Aggregate | ORDER BY | Holds |
|---|---|---|
| `import_daily` | `day` | `imports`, `accounts_created`, `burned`, `minted`, `config_version`, `version`. |

Volume adds the metric `import_volume`, with live periods day/7day/30day and one component per kind.

### Part D: remit, cron and remarks

| Table | Kind | ORDER BY | Holds |
|---|---|---|---|
| `remits` | ledger, P6 | `(ledger_index, tx_index)` | Columns: `account`, `destination`, `amount_count`, `uritoken_count`, `minted_uritoken_id`, `inform`, `blob_size`, `invoice_id`, `destination_tag`, `tx_hash`, `close_time`. |
| `remit_amounts` | ledger, P6 | `(ledger_index, tx_index, amount_index)` | `currency`, `issuer`, `amount`, `amount_f`. |
| `account_remits` | ledger, P7 | `(account, ledger_index, tx_index)` | Columns: `role` (`sender` or `destination`). |
| `cron_runs` | ledger, P7 | `(owner, ledger_index, tx_index)` | One row per `Cron` pseudo-transaction: `scheduled_ledger` (`LedgerSequence`), `hook_executions` (count), `tx_hash`. |
| `remarks` | ledger, P7 | `(object_id, name, ledger_index, tx_index)` | Columns: `account`, `action` (`set` or `delete`), `value_hex`, `value_text` (when printable), `immutable`, `object_type` (from the object's node), `tx_hash`. |
| `account_remarks` | ledger, P7 | `(account, ledger_index, tx_index, object_id, name)` | A narrow index. |

`Cron` objects are tracked in `object_changes` as type `Cron`.

## 2. Parsing

There are four new pure parsers: `hooks.parser.ts`, `rewards.parser.ts`, `import.parser.ts` and `xahau-misc.parser.ts` (Remit, Cron, Remarks). The `object_changes` tracked types gain `Hook`, `HookDefinition` and `Cron`.

**Hooks**
- `HookExecutions` and `HookEmissions` are parsed for every transaction that has them, including failed transactions. Hooks run and are recorded even on `tec*`; Task 1 confirms this.
- `SetHook` positions are decided from the transaction entry plus the account's `Hook` object diff. An empty entry is a `noop`. A `HookHash` or `CreateCode` on a free position is an `install`. Changed parameters or grants on the same hash are an `update`. The delete flag (or an empty `CreateCode`) is a `delete`. The namespace-delete flag is a `namespace_delete`.

**Rewards**
- `ClaimReward` gives one claim row.
- A `GenesisMint` (an emitted transaction) gives one row per entry, with `parent_tx_hash` taken from `EmitDetails.EmitParentTxnID`.
- Whether the parent was a claim is decided by the aggregator, through a `tx_by_hash` lookup, not by the pure parser.

**Import**
- The `Blob` is decoded (hex, then JSON). The XRPL transaction is decoded with the XRPL definitions (`packages/shared/config/definitions/xrpl.json`), and its hash is computed.
- `kind` and `burned` follow the rules FINDINGS establishes. For example, B2M is an XRPL transaction with `OperationLimit` = 21337, and its `Fee` is the burn.
- `minted` is the `AccountRoot` balance delta of `Account`. This includes a newly created account.

**Remit**
- One `remits` row, plus one `remit_amounts` row per amount.
- URIToken transfers and mints from a `Remit` are left to family 2.
- Remit amounts also go to balance changes, already typed today, and to payment volume (the decision below).

**Cron and Remarks**
- **Cron:** `Cron` pseudo-transactions give `cron_runs` rows; `CronSet` is visible through `object_changes`.
- **Remarks:** `SetRemarks` gives one `remarks` row per entry, with `object_type` read from the target object's node in the metadata.

### Decision: Remit counts as payment on Xahau

The user chose "Remit as payments". Each `remit_amounts` entry counts in `payment_volume` (components per configured currency). `/v2/remits` and `/v2/accounts/:a/remits` list Remits.

`/v2/payments`, which follows the Ripple contract, keeps listing `Payment` transactions only. Remit has a different shape (several amounts, no paths, no delivered amount). This is recorded in ADR-0010.

## 3. API

On XRPL every route in this table answers empty lists or 404 on the XRPL network, per the roadmap's shared rules.

| Route | Params | Response |
|---|---|---|
| `GET /v2/hooks` | `sort=executions\|installs\|created` (default `executions`), `limit`, `marker`, `format` | `{result, count, marker?, hooks:[Hook]}` |
| `GET /v2/hooks/:hash` | — | `{result, hook}`; 404 `hook not found`; 400 `invalid hook hash` |
| `GET /v2/hooks/:hash/executions` | `start`, `end`, `result`, `account`, `descending`, `limit`, `marker`, `format` | executions |
| `GET /v2/hooks/:hash/installs` | `start`, `end`, `action`, `descending`, `limit`, `marker`, `format` | install events |
| `GET /v2/hooks/:hash/stats` | `start`, `end`, `descending`, `limit`, `marker`, `format` | `days:[HookDay]` |
| `GET /v2/accounts/:address/hooks` | — | `{result, hooks:[{position, hook_hash, namespace, hook_on, parameters, grants}]}`: the current positions, from the latest `Hook` object |
| `GET /v2/accounts/:address/hook_executions` | `start`, `end`, `hook`, `result`, `descending`, `limit`, `marker`, `format` | executions of hooks installed on the account |
| `GET /v2/transactions/:hash/hooks` | — | `{result, executions:[...], emissions:[...], emitted_by?:{parent_tx_hash, hook_hash, generation}}`. `emitted_by` comes from the transaction's own `EmitDetails`. |
| `GET /v2/accounts/:address/rewards` | `start`, `end`, `descending`, `limit`, `marker`, `format` | `{result, count, marker?, rewards:[{claim_tx_hash?, claimed_at?, mint_tx_hash?, minted_at?, amount?, opt_out}]}`. Claims and their mints are paired by parent hash; an unpaired claim or mint is still listed. |
| `GET /v2/network/reward_volume` | the volume-route params (live day/7day/30day, or historical) | the reward volume rows |
| `GET /v2/imports` | `start`, `end`, `kind`, `descending`, `limit`, `marker`, `format` | imports |
| `GET /v2/accounts/:address/imports` | the same | the account's imports |
| `GET /v2/network/import_volume` | the volume-route params | the import volume rows |
| `GET /v2/remits` | `start`, `end`, `descending`, `limit`, `marker`, `format` | `{result, count, marker?, remits:[{..., amounts:[...], uritoken_ids:[...]}]}` |
| `GET /v2/accounts/:address/remits` | `role=sender\|destination\|any`, plus the above | the account's remits |
| `GET /v2/accounts/:address/cron` | `history` | the current `Cron` object (from `object_changes`) and its runs (from `cron_runs`); 404 `cron not found` |
| `GET /v2/objects/:id/remarks` | `history` | the current remarks per name, or their history |
| `GET /v2/accounts/:address/remarks` | `start`, `end`, `descending`, `limit`, `marker`, `format` | the remarks set by the account |

## 4. Aggregation

All of these jobs follow the roadmap's shared rules:

- `hooks` runs every tick, from a watermark.
- `hook_daily`, `reward_daily` and `import_daily` run on a cadence of every 5 ticks.
- The metrics `reward_volume` and `import_volume` are written in the volume sets. The live sets are written each tick; daily rows follow the volume job.
- Payment volume reads `remit_amounts` on Xahau.

## 5. Testing

- **Fixtures** (Task 1):
  - Hooks: a `SetHook` install with `CreateCode`, an install by `HookHash`, an update, a delete, and a namespace delete.
  - Hook executions with accept, with rollback, and on a `tec*` transaction, plus a hook emission and the emitted transaction.
  - Rewards: a `ClaimReward` (opt-in and opt-out) and its `GenesisMint`.
  - Imports: one of each kind, including one that creates an account.
  - Remit: amounts only; amounts + URIToken transfer + mint; with `Inform`.
  - Cron: `CronSet`, its `Cron` run, and an unset.
  - Remarks: `SetRemarks` set, delete, and immutable.

  `FINDINGS.md` confirms the `HookResult` codes, whether hooks run on `tec*`, the import kinds and the B2M burn rule, and the `Cron` fields.
- **Parser golden tests,** with an oracle reimplementation, plus these invariants:
  - execution indexes are unique per transaction;
  - `GenesisMints` amounts equal the destinations' balance deltas;
  - `minted` equals the `AccountRoot` delta;
  - the Remit amount count equals `Amounts`.
- **The rest** follows the shared pattern. In addition, every route on an XRPL harness answers empty or 404.

## 6. Out of scope

- `HookState` contents and history: only the per-execution count is kept.
- Disassembling or verifying hook code.
- Governance-hook vote semantics.
- Balance-rewards accrual forecasting.
