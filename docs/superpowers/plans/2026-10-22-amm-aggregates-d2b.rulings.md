# AMM data additions to the aggregates (D2b): rulings made during implementation

Every decision the controller made while executing `2026-10-22-amm-aggregates-d2b.md` where the spec and plan were silent, ambiguous
or in conflict, verbatim from the execution ledger: what was decided, why, and what it costs if wrong. P1–P16 were made before Task 1
(P5–P14 are the plan's decisions D1–D10); the rest during the tasks and the final review. The product decisions among them are also
recorded in the D2b section of `docs/adr/0013-account-and-market-aggregates.md`.

## Rulings

- Ruling P1: the plan has no D2b tasks, so this session wrote docs/superpowers/plans/2026-10-22-amm-aggregates-d2b.md with the writing-plans skill (commit e3dff16) and runs it without an owner-review pause — the starting session asked for D2's subagent-driven auto mode, and the owner's standing rule is to run an approved auto-mode plan to the end — costs: if the owner wanted to see the plan first, they review it with the code (the hand-back points at it).
- Ruling P2: the ledger lives in the skill's canonical workspace .superpowers/sdd/2026-10-22-amm-aggregates-d2b; the baseline outputs already started in .superpowers/sdd/2026-10-22-d2b-amm-aggregates (a directory this session created) are moved here when the baseline ends — costs nothing.
- Ruling P3: Task 7 makes `VolumeLiveRow.fees_est_f: number | null` a required field (the rows.ts convention: every column is a field) and adds `fees_est_f: null` to every typed construction of `VolumeLiveRow` in the three packages, tests included, checking that the api and syncer test files still typecheck — costs a few more touched test files.
- Ruling P4: in `componentFeesEst`, a side whose fee sum is exactly 0 contributes 0 without dividing by its volume — completes plan D8 (a 0 volume must not make NaN) — costs nothing.
- Ruling P5 (plan D1): every network/markets answer echoes `amm` after `period` (`include` by default, the no-set answer too) — `period` is echoed when defaulted, and spec D2b.1 says `amm` is "served in the answer after `period`" — costs one fixture line per unfiltered file in the explorer if the owner prefers no echo.
- Ruling P6 (plan D2): `amm_share` stays the share of the stored base volume and does not change on an inverted row; the reference says so and the hand-back asks the owner whether a counter-side share is wanted — spec D2b.1 defines it on the base — costs a field later if the owner wants one.
- Ruling P7 (plan D3): `total_amm_share` = Σ(native × amm_base ÷ base) ÷ Σ native over the include pairs with a native volume, exact quotients rounded once to 4 decimals, `"0.0000"` without any native volume, the same on all three sentinels — the explorer's reference already computes it from exact shares rounded once — costs the last digit if the owner wanted rounded shares summed.
- Ruling P8 (plan D4): the parser gate is one rule on both networks (min `parser_version` of the window's ledgers ≥ `AMM_PARSER_VERSION` = 2; a window without a ledger passes); Xahau's `"0.0000"`/`false` follow from its data — costs nothing on recreated databases (every ledger is parser 2 after the AMM merge).
- Ruling P9 (plan D5): `amm_share` is NULL for a pair whose include base volume is not above 0 (impossible for a kept trade); a pair without swaps has `"0.0000"` — costs nothing.
- Ruling P10 (plan D6): a run writes the three filter sets of a period from one read of the hour sets, as three inserts (exclude, only, include last), each its own version; a missing hour skips all three — costs nothing.
- Ruling P11 (plan D7): `amm` is checked after the display currency, its place in spec 7's parameter table — costs only the order of two errors.
- Ruling P12 (plan D8): `fees_est` counts every swap of the window as `amm_daily` does (no dust filter) and converts with the component's own (dust-filtered) volumes; a side with fees above 0 and no volume makes the component unknown — the difference is at most the fees of dust swaps — costs a negligible mismatch with a dust-filtered estimate.
- Ruling P13 (plan D9): the row's `fees_est` is there only when the row lists at least one component and all of them have one — a quiet 24 h row has none rather than an unprovable "0" — costs: the explorer shows no 24 h fee total for a row without pools.
- Ruling P14 (plan D10): `computed_start`/`computed_end` come from the request's window, never narrowed by the marker, and count a day only when its newest sentinel has the current `AMM_DAILY_CONFIG_VERSION` — spec D2b.4 says "the same on every page" and "a set of the current AMM_DAILY_CONFIG_VERSION" — costs nothing.
- Ruling P15: the two open items are settled by P5/P6 in code, the reference and ADR-0013, not by editing the approved spec; the hand-back proposes the spec wording — D2's run did not edit approved specs either (R6b) — costs one owner edit of the spec.
- Ruling P16: models — implementers sonnet, except Tasks 2 and 7 (multi-file design: the filter sets and the gate; the fee estimate across amm-daily and volume) on opus; task reviewers sonnet, opus for Tasks 2 and 7; the final whole-branch review on the most capable model available (fable, else opus) — costs tokens if Tasks 2/7 did not need opus.
- Task 2: Ruling: accept the one red API e2e assertion between Tasks 2 and 4, and run Task 4 before Task 3 so the window is one task long — the assertion pins the D2 shape of markets_live that Task 4 is planned to rework (decoys, world with explicit amm_account) — costs: the API e2e is red at e9acb33 (one assertion) until Task 4 lands.
- Task 2: Ruling: accept concern 4 — sets are keyed by (period, amm), each version from its own set's nextSetVersion, so equal numbers across filters are harmless — costs nothing.
- Task 6: Ruling: keep the spec's parser gate (min parser_version only) and add no agg_dirty condition; Task 10's observability/operations docs say that AMM_DATA is turned on once agg_dirty has drained after the reprocess (besides spec 16.4's gauges) — spec 12 accepts that aggregates show old data between a rewrite and its hook (eventual, as stats_hourly), and the window closes when agg_dirty drains — costs: an understated AMM share for minutes after a reprocess if the owner flips AMM_DATA before the drain.
- Task 6: Ruling: fix the duplication — extract the copied helpers into one syncer test support module (apps/syncer/test/aggregates-e2e-support.ts) imported by both aggregate e2e specs; the plan's file list names the new spec but does not forbid a support file, and the copies of fakeMetrics must mirror the real metrics object (just edited for the new gauge) — costs one more file and an edit of aggregator-aggregates.e2e-spec.ts.
- Task 7: Ruling: accept concern 2 (the slot columns stay required in the window's carry) — amm_daily already walks the same pools back with the same required columns on every run of today's set, so the live day set adds about one day-read per tick, the spec's cost line; narrowing the required carry to the trading fee (a slot lasts 24 h, far less than the 160,000-ledger window) would change amm_daily's own rule and is parked as an owner follow-up for both jobs — costs: one extra walk back per slot-less pool per tick until then.
- Final: Ruling F1: the validators failure is D1's, out of D2b's scope — not fixed here; the full gate is re-run after 02:51 UTC, and the hand-back lists the D1 test flake and the firstRound() edge as a follow-up — costs: the D1 test stays red between 00:00 and 02:51 UTC until fixed.
- Final: Ruling F2: the one fix wave takes I-2, I-1's docs line (no code change; the measurement is an owner step before AMM_DATA, recorded in the hand-back), M-1, M-2, M-3 (all four) and M-5; M-4 stays (harmless) — the reviewer's triage keeps every other deferred minor deferred — costs: a few small edits in one wave.
- Final: Ruling F3: park the I-2 residual (docs only; no second fix wave per the process) — docs/deployment.md:100-102, docs/operations.md:482-484, docs/adr/0013-account-and-market-aggregates.md:137-138 and the 004 row of docs/data-model.md:402 overstate the syncer's dependency on 004; the order they prescribe (migrate → syncer → API) stays safe; the hand-back gives the owner the corrected wording (migrate before the API is required; before the syncer advisable, else the estimates of the ticks before it are dropped; the volume_live error counter is not the signal) and a follow-up card is proposed — costs: a wrong explanation and a misleading monitoring hint in the runbook until that 4-place edit lands.
- Final: Ruling F4: keep this workspace instead of deleting it — the owner reads the ledgers after a run (D2's workspace was kept the same way) and the deletion guard prefers keeping; the committed rulings digest carries every ruling either way — costs: a gitignored directory of review packages on disk.

## Open for the owner

- **Spec wording (P15). Done (owner decision, 2026-10-22: both written into spec D2b.1; no counter-side share).** Spec D2b.1 did not say whether an unfiltered `network/markets` answer echoes `amm`, nor how `amm_share`
  behaves on an inverted row. Proposed text, after "served in the answer after `period`": "— always, `include` when the request has
  none, the answer without a set too"; and after the definition of `amm_share`: "It is the share of the stored base volume, so a
  consumer that shows the pair inverted shows the same share (the counter-side share differs only by the price gap between the pool's
  and the book's trades in the window)." Whether a counter-side share is wanted is the owner's call (P6).
- **The reason for "migrate first" in the docs (F3). Done.** `docs/deployment.md` (~:100), `docs/operations.md` (~:482-484), the D2b
  section of ADR-0013 (~:137-138) and the 004 row of `docs/data-model.md` (~:402) said a D2b syncer before 004 fails its live volume
  inserts. On the pinned ClickHouse 26.8 `input_format_skip_unknown_fields` defaults to 1 (checked on a throwaway 26.8.14.3 container:
  a JSONEachRow row with an extra field is inserted at the default and rejected only when the setting is forced to 0, and
  `ClickHouseService.insert` does not change it), so it does not: the estimates of the ticks before `migrate` are silently dropped.
  The four places now say: run `migrate` (004) before the API (required: the live `amm_volume` day read selects `fees_est_f`) and
  before the syncer (advisable: else the fee estimates written before the migration are lost);
  `syncer_aggregator_errors_total{job="volume_live"}` does not show the missing column. The order stays migrate, syncer, API. Also
  `operations.md`: `live` defaults to `day`, so the bare route reads the column too (it said `?live=day`), and "the hook" is the
  `pair_hourly` hook.
- **Measure the live day set before `AMM_DATA` (final review I-1).** The live `amm_volume`/`day` set now estimates fees every tick
  inside the 5 s `volume_live` budget the twelve live sets share; measure its duration on the mainnet database (the spacing of the
  live sets' versions) before turning `AMM_DATA` on. Mitigations, cheapest first: raise `AGGREGATOR_VOLUME_LIVE_BUDGET_MS`; compute
  the estimate every Nth tick; narrow the required fee carry to the trading fee for both jobs (Task 7 ruling).
- **D1, outside D2b (F1).** `apps/syncer/test/validators.e2e-spec.ts` "starts at the first voting ledger at or after the lowest ledger
  of the oldest validations" fails between 00:00 and about 02:51 UTC: `validations` is partitioned by the UTC day of `last_datetime`,
  and its ledger-0 record then lands in the previous day's partition. The same case exposes a D1 edge in
  `apps/syncer/src/validators/rounds.job.ts` `firstRound()`: an oldest partition that holds only ledger-0 records yields no first
  round until its TTL drops it.
- **The explorer (P5).** Every unfiltered `network/markets` answer now has `"amm": "include"`, and the markets answers carry
  `amm_share`, `amm_pool` and `totals.amm_share` once the window is parser 2; x-explorer's fixtures follow the regenerated
  `docs/openapi.yaml` (`pnpm api:sync`).
- **The rollout** is D2b.6's, after the AMM rollout: `migrate`, the syncer (the `pair_hourly` catch-up at config version 2 re-reads
  the 31 days), the API; `AMM_DATA` per environment by spec 16 step 4 and only once `agg_dirty` has drained after the reprocess
  (`docs/operations.md`, "The AMM data additions").
