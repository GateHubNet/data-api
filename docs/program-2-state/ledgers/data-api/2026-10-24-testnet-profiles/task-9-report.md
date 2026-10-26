# Task 9 report: A testnet reset halts the syncer

Status: DONE_WITH_CONCERNS (concerns are design notes for the reviewer, none blocks).
Commit: `6a2f31b feat(syncer): a testnet reset halts the live runner instead of waiting forever` (worktree `explorer-data-2`, branch `feat/explorer-data-2`, on top of `c0d5d91`).

## What was implemented

**`packages/shared/src/ingest/ingest-state.ts`**: `firstCommittedLedger(ch): Promise<number | undefined>`, `SELECT minOrNull(ledger_index) FROM ledgers` (exported through `src/index.ts` already via `export * from './ingest/ingest-state'`).

**`apps/syncer/src/ingest/live-runner.ts`**
- `export const HEAD_BELOW_CHECK_MS = 60_000`; `LiveRunnerOptions.headBelowCheckMs?` (default `HEAD_BELOW_CHECK_MS`).
- `observeHead` now calls `noteHeadBelow(index)` first: a head (hint or poll) below `this.committed` is recorded as `headBelow` (the runner's `head` still never goes down); a head at or above the checkpoint clears `headBelow` and `headBelowChecked` (a later dip is checked anew, still rate limited).
- `checkHeadBelowIfDue()`, called from the pipeline's loop right after `pollHeadIfSilent()`: runs `compareHeadBelow(head)` in the background (one at a time, `checkingHeadBelow`) when `headBelow` is not `headBelowChecked` and `headBelowCheckMs` has passed since the last check ended (`headBelowCheckedAt`, 0 at start so the first is at once). A `ChainBreakError` halts the runner (`halt()`, so status `halted`, 503, `syncer_ingest_halts_total{reason="chain_break"}`); any other failure is a warning and the head stays unchecked, so the next due check tries again. Nothing is reported after `stop()`.
- `compareHeadBelow(head)` (the check, shared by the loop and boot): `storedLedgerHash(ch, head)`. With a stored hash: one `source.fetch(head)` (a ledger of another index than asked is an error, not a halt); another hash throws `ChainBreakError("The node's validated ledger <head> has hash <h1>, but ledger <head> is stored with hash <h2>: the network was reset, or the node is of another chain", head)` on every network; the same hash logs the warning `The node's validated head <head> is below the checkpoint <checkpoint>, with the stored hash: waiting for it to catch up`. With no stored hash: `head < firstCommittedLedger` and `getNetworkProfile(cfg.network).kind === 'testnet'` throws `ChainBreakError("The node's validated head <head> is below the first indexed ledger <first>: the network was reset", head)`; a mainnet, or a gap, waits. Messages are verbatim from the brief.
- `waitBudget()` also wakes the loop when a head below is due for its check (with the real 15 s `headSilenceMs` and 60 s check interval the check would otherwise be late by up to a poll interval).
- `prepare()` with a checkpoint: `source.validatedHead()` first, `compareHeadBelow(head)` when it is below the checkpoint, then the unchanged `storedLedgerHash(checkpoint)` / `fetchLedger(checkpoint)` (which waits for a node that is behind, as today). The boot check records the head as checked, so the loop does not repeat it.
- Class/`ChainBreakError` doc comments describe the rule and say that the hash comparison holds on every network, mainnet included, and changes mainnet behaviour on purpose (controller ruling P7).

**Docs**: `docs/syncer.md` (new section "A head below the checkpoint", a pointer in "Verify" and in "The loop", two rows in the failure-modes table); `docs/operations.md` (new "A testnet was reset" with the runbook as five steps: stop `syncer-<slot>`, `api-<slot>`, `exporter-<slot>`; `DROP DATABASE xrpl_testnet` after reading `syncer_lease.network`, never a mainnet name; `run --rm migrate-<slot>`; start the syncer and the api; insert the account network names again; the shared database is kept; the explorer deploys the sandbox with a new build id, E7 section 11; plus how to make sure it is a reset first, and a bullet in "Syncer halted"; "a reset test net" removed from the wrong-network bullet there); `docs/troubleshooting.md` (the two messages: symptom, root cause, fix). Where they speak of mainnet, they say the hash halt applies on every network (ruling P7) and only the below-first-ledger halt is testnet-only.

## Tests

`apps/syncer/test/live-runner.e2e-spec.ts`: `TestSource.useChain(chain)` (and `byIndex` no longer readonly); `RESET_CHAIN = syntheticChain(L(1), 30, { salt: 'reset' })`; new `describe('a head below the checkpoint (a reset testnet, or a node that is behind)')` with the brief's six cases and a seventh (my addition, see concerns):
1. halts at boot, head below the checkpoint under another hash: `runOnce` rejects with `ChainBreakError`, exact message and `ledgerIndex` L(5); status `{ state: 'halted', checkpoint: L(10), error }`; `source.fetches` is `[L(5)]`; `syncer_ingest_halts_total{chain_break}` +1; committed ledgers untouched.
2. waits at boot with the stored hash: not halted after 500 ms, exactly one check fetch of L(5), exactly one warning with the verbatim text; head raised to L(12) commits L(11), L(12).
3. halts while live (head L(10), `useChain(RESET_CHAIN)`, head L(3), `headSilenceMs` 50, `headBelowCheckMs` 300): halted with the message; the halted runner's `runOnce` rejects with `ledgerIndex` L(3).
4. once per distinct head and at most once per `headBelowCheckMs`: the boot's only fetch is the checkpoint; head L(5) is fetched once; head L(6) set at once after is not fetched 120 ms later, then is, at least 300 ms after the check of L(5); 700 ms more of polls add no fetch; `source.fetches` is exactly `[L(10), L(5), L(6)]`; not halted.
5. testnet, head below the first indexed ledger: `network: 'xrpl-testnet'`, `syncStartLedger: L(10)`, L(10)..L(20) committed, head L(3): the second message with first L(10); `source.fetches` is `[]`.
6. mainnet, the same: not halted after 500 ms, no fetch of L(3).
7. (extra) testnet, head in a gap of the stored ledgers (L(10), L(11), L(15), L(16) stored, head L(13)): waits, no fetch of L(13). Pins that the testnet halt is `head < first`, not `head <= checkpoint`.

`packages/shared/test/ledger-writer.e2e-spec.ts`: `firstCommittedLedger is undefined on an empty database and the lowest committed ledger after writes` (empty; uncommitted child rows do not count; after a write; a lower ledger written later becomes the first while the checkpoint stays).

## TDD evidence

RED, shared: `pnpm --filter @gatehub/data-api-shared test:e2e ledger-writer -t firstCommittedLedger` -> `TS2305: Module '"../src/ingest/ingest-state"' has no exported member 'firstCommittedLedger'` (suite failed to run, expected: the function did not exist). GREEN after adding it: `Tests: 45 skipped, 1 passed`.

RED, syncer (final tests, the implementation of `live-runner.ts` reverted to HEAD plus only the `headBelowCheckMs` option field so the spec compiles; restored byte for byte afterwards, checked with `diff`): `npx jest --config ./test/jest-e2e.json --runInBand live-runner -t "a head below the checkpoint" --testTimeout=20000`:
```
✕ halts at boot when the node's head is below the checkpoint under another hash: the network was reset (20045 ms)   <- Exceeded timeout (the boot waits on the checkpoint fetch)
✕ waits at boot when the node's head ... the node is behind          <- expect(source.fetchCount(L(5))).toBe(1): Received 0 (no check made)
✕ halts while live when the head falls below the checkpoint under another hash (20028 ms)   <- never halts
✕ checks a head below the checkpoint once per distinct head and at most once per headBelowCheckMs (20041 ms)  <- waits for a check that never comes
✕ on a testnet, halts when the head is below the first indexed ledger (20039 ms)   <- Exceeded timeout
✓ on a mainnet, waits when the head is below the first indexed ledger          (waiting is today's behaviour: pins it)
✓ on a testnet, waits when the head is below the checkpoint in a gap of the stored ledgers   (same)
```
Why expected: today a head below the checkpoint is ignored and the boot waits forever on the checkpoint fetch; the two passing cases pin behaviour that must not change.

GREEN: same command with the implementation: `Tests: 33 skipped, 7 passed, 40 total` (three further runs in a loop: 7 passed each, so the timing cases are stable).

Mutation checks (to make sure the two "waits" cases bite): dropping `kind === 'testnet'` fails `on a mainnet, waits ...`; dropping `head < first` fails `on a testnet, waits ... in a gap ...`. Both restored.

(Side note: my first RED attempt, `pnpm ... test:e2e -- live-runner -t ... --testTimeout=...`, passed the flags to jest as test-path patterns and ran the whole file: 428 s, all 35 existing tests passed, and the same five new ones failed. Used `npx jest` afterwards.)

## Verification (global constraints)

- `pnpm exec prettier --check` of my four TS files: clean (only my files were formatted; docs are not prettier-managed in this repo).
- `pnpm build`: exit 0. `pnpm test`: exit 0 (shared 1682, exporter 12, api 1854, syncer 1336 tests).
- `pnpm --filter @gatehub/data-api-shared test:e2e`: exit 0, 15 suites, 877 tests (includes ledger-writer).
- `pnpm --filter @gatehub/data-syncer test:e2e`: exit 0, 13 suites, 344 tests (includes live-runner and app). No console noise from the new tests.
- Ryuk pulled fine; `TESTCONTAINERS_RYUK_DISABLED` was not needed. The api package is untouched, so its e2e was not run.

## Files changed (7)
`packages/shared/src/ingest/ingest-state.ts`, `packages/shared/test/ledger-writer.e2e-spec.ts`, `apps/syncer/src/ingest/live-runner.ts`, `apps/syncer/test/live-runner.e2e-spec.ts`, `docs/operations.md`, `docs/troubleshooting.md`, `docs/syncer.md`.

## Self-review

- Complete against the brief: the interface, the rule (record, due check, the two throws, the warning, the boot check), `ChainBreakError` halting as today, the six tests, the shared test, the three docs. Messages compared verbatim in the tests.
- Followed the brief's literal text where it is specific. The mainnet note (P7) is in the code comments and in `syncer.md`, `operations.md`, `troubleshooting.md`.
- No parser, migration, config or compose change.

## Concerns / notes for the reviewer

1. **Boot: a failed check is retried, not just warned.** In the loop a failed `fetch(head)` is a warning and the next due check retries (as the brief says). At boot no loop runs yet, so a warning-only failure would fall through to `fetchLedger(checkpoint)`, which waits forever on a reset chain. There a failure (of `validatedHead()` or of the head fetch) rejects out of `prepare()` into `untilDone`, which logs it as an error, sets `recovering` in the probe details and retries with backoff. Consequence: with a checkpoint and the node unreachable at boot, the probe now shows `recovering`/`error` (details only, the state is not made `halted`/503 by it) where before the checkpoint fetch retried silently with warnings. Same behaviour as the empty-database branch, whose `validatedHead()` already worked this way.
2. **Boot, node behind, then reset.** As the brief says, after a same-hash boot check `prepare()` goes on to the checkpoint fetch, which waits. If the testnet is reset during that wait, nothing re-checks until a restart (the loop starts after `prepare()`). Closing it would mean re-checking inside that wait; not done (outside the brief).
3. **`headBelowChecked` is cleared when the node reports a head at or above the checkpoint**, so a later dip to the same number is checked again (still at most once per `headBelowCheckMs`). Not in the brief; it keeps "once per distinct head" meaning once per dip. A node alternating between a lagging and a current endpoint would warn at most once a minute.
4. A hint below the checkpoint counts like a poll (the brief says hint or poll): a lagging endpoint's out-of-order hint gets the "waiting for it to catch up" warning, at most once a minute.
5. Seventh test (the gap) is beyond the six named; `useChain` replaces the ledgers of the `TestSource` as specified.
6. Docs: the explorer's sandbox spec (E7) does not exist in `x-explorer` yet, so "section 11" is named in prose without a link; `<slot>` is explained in the runbook (the testnets run in the `xrpl`/`xahau` services; compose gains `XRPL_NETWORK` only in Task 10). The runbook also says to start `exporter-<slot>` again if exports are on (the brief lists only syncer and api for the start).
