# Task 7 report: The fixed list in the validators worker

Status: DONE (one deviation from the brief's e2e boot options, below). Commit: `36e5a33 feat(syncer): the fixed validator list is stored as the list of the publisher local`.

## What was implemented

- `apps/syncer/src/validators/unl-fetcher.ts`
  - `export const LOCAL_LIST_EXPIRATION = 4_294_967_295` and `export function localListRow(keys, sequence, nowSeconds): UnlListsRow` (keys sorted on a copy, `blob_sha256` = upper-case hex SHA-256 of the sorted keys joined by `\n`, `response` = `JSON.stringify({ validators: sorted })`, `effective = Math.floor(now)`, `fetched_at = now`, `version` 1, `publisher_key` `''`, `publisher` = `LOCAL_PUBLISHER_ID`).
  - `registerPublishers()`: with a non-empty fixed list, `storeFixedList` (reads the `local` lists with `readStoredLists`, takes the highest sequence, writes `localListRow(keys, newest + 1 or 1)` only when the sorted keys differ from the newest stored list's sorted validators, or none is stored), then the `local` `unl_publishers` row (`localPublisherRow`: `url ''`, `publisher_key ''`, `configured 1`, `threshold unlThresholdOf(cfg)`, `status 'ok'`, `error ''`, `checked_at` and `last_ok_at` now). The list is written before the publisher rows, as an attempt writes lists before its publisher row. The loop for unconfigured stored publishers skips `local` while the fixed list is not empty; with an empty fixed list a stored `local` with `configured: 1` gets the usual `configured: 0` row (values kept).
  - `local` is never a `Publisher` of the map: no timer, no fetch, no metric; `fetchOnce('local')` rejects `local is not a configured UNL publisher` as for any unconfigured id (no code change needed for that, pinned by a test).
  - `UnlFetcher` class doc and the `registerPublishers` doc gained the fixed-list paragraphs.
- `apps/syncer/src/validators/stored-lists.ts`: `loadListContext` appends `LOCAL_PUBLISHER_ID` to the publisher ids when `unlValidatorsOf(cfg)` is not empty, so `lists` is read for the publishers and `local`, and the `ListContext` threshold (`unlThresholdOf`, which already counted the fixed list) and the lists agree. This closes the Task 6 reviewer's transitional gap.
- `apps/syncer/src/validators/domain-checker.ts`: `CheckerConfig` gained `unlValidators`; `validatorKeys` adds `unlValidatorsOf(this.cfg)` to the masters (Ruling 8). It reads the keys from the configuration, not from the stored `local` lists: the publisher loop matches a list to the key configured for the publisher, which `local`'s `''` never matches, and the fixed list is in force before it is stored.

## Tests

New/changed specs (all pass):
- `unl-fetcher.spec.ts`: `setup` gained `validators`; `describe('the fixed list (GH_UNL_VALIDATORS)')`: writes the local publisher and its list at start (every field of both rows); local's row beside a URL publisher's; no list when the stored local list has the same keys (another order, stored sequence 3); next sequence when the keys changed (3 -> 4); compared with the newest stored list, not an older one; a replaced key; `configured = 0` on a stored local when the fixed list is empty (values kept, history untouched); nothing for local when empty and none stored; an already-unconfigured local is left alone; never fetches local (one URL publisher: only the URL fetched, one timer, `fetchOnce('local')` rejects, no `local` label on any metric); only the fixed list: no timer, no fetch; thresholds counting the fixed list (one URL + local: 1; three URLs + local: 3, all four rows); `GH_UNL_THRESHOLD` on local's row. `describe('localListRow')`: the constant is 2106-02-07T06:28:15Z; every field of the row (floor of a fractional now, hash, response); input not reordered; same keys in any order give the same hash and response.
- `stored-lists.spec.ts` (new): reads the fixed list beside the publishers and trusts its four validators at threshold 1 (`publishers ['local']`, query param `['local']`, exact `StoredUnlList`, `unlAt` holds the four keys); `[ID, 'local']` order with a publisher; at threshold 2 a validator needs the publisher to name it too; local left out when the fixed list is empty (no query for `local`); nothing read when there is neither.
- `domain-checker.spec.ts`: `setup` gained `validators`; the fixed-list key never seen is checked as on a list in use (together with a publisher's list validator, and an unseen second fixed key); with no publisher at all; once when the fixed list, a publisher and `validator_seen` all name it.
- `validators.e2e-spec.ts` (real ClickHouse): `Xahau Testnet: registers the fixed list as the publisher local, and a restart with the same keys writes no list` (profile `xahau-testnet`, fake node with `network_id` 21338, the four default keys of the profile: the `local` publisher row exact, one `unl_lists` row with every field including `expiration` 4294967295 read back from `DateTime`, `listInUse` not expired, no web request; a restart with the keys reversed leaves the same single row); and `Xahau Testnet: writes the next sequence when the keys changed, and marks local no longer configured when none is left`.

### TDD evidence
- RED (unit): `pnpm --filter @gatehub/data-syncer test -- unl-fetcher stored-lists domain-checker` -> `Test Suites: 3 failed, 3 total; Tests: 2 failed, 133 passed`. `stored-lists.spec.ts` and `unl-fetcher.spec.ts`: `TS2305: Module '"./unl-fetcher"' has no exported member 'localListRow'` (and `LOCAL_LIST_EXPIRATION`); `domain-checker.spec.ts`: both new cases failed (`Expected: 3 Received: 1`, `Expected: 1 Received: 0`: the fixed list's keys were not checked). Expected failures, as the brief says.
- RED (e2e): the implementation was not committed yet when the e2e was first run, so its RED is by mutation: with `registerPublishers` made to see an empty fixed list (`const fixed: string[] = []`), both new e2e cases fail (`Tests: 2 failed, 129 skipped`); the line was restored byte for byte (`cmp` against a copy).
- GREEN: `pnpm --filter @gatehub/data-syncer test -- unl-fetcher stored-lists domain-checker` -> `Test Suites: 3 passed; Tests: 239 passed`; e2e `-t 'fixed list'` -> `2 passed, 129 skipped`.

### Full verification before the commit (after the last edit)
- `pnpm exec prettier --check` on every changed file: clean (only my own files were formatted).
- `pnpm build`: all four projects Done.
- `pnpm test` (root, run once before the final cosmetic reordering): shared 1682, exporter 12, api 1852, syncer 1336 tests, all passed; re-run for syncer after the reordering: `Test Suites: 35 passed; Tests: 1336 passed`.
- `pnpm --filter @gatehub/data-syncer test:e2e`: `Test Suites: 13 passed; Tests: 337 passed`, no `console.*` noise.
- Only `@gatehub/data-syncer` was touched (shared was not), so no other package's e2e was needed. No worker spec timed out.

## Files changed
- `apps/syncer/src/validators/unl-fetcher.ts`, `unl-fetcher.spec.ts`
- `apps/syncer/src/validators/stored-lists.ts`, `stored-lists.spec.ts` (new)
- `apps/syncer/src/validators/domain-checker.ts`, `domain-checker.spec.ts`
- `apps/syncer/test/validators.e2e-spec.ts`

## Self-review

- Completeness against the brief: every interface item and every named test is present with the brief's wording (`never fetches local: no timer, no fetch and no metric of it`, the threshold case with one and three URLs, and so on). Extra cases are limited to behaviours the code decides (newest-vs-older comparison, empty/unconfigured edges, domain-checker dedupe, `localListRow` fields).
- Deviation (e2e boot): the brief says `worker: { start: { state: false } }` as `boot()` passes it. With four fixed keys the domain loop has keys to check, and a pass that was under way when the app closed logged `socket hang up` ClickHouse errors (`console.error`) in the passing run; `boot()` never hits this because it has no keys, so its pass returns before any query. The Xahau Testnet e2e therefore boots with `start: { state: false, domains: false }` (comment in the code). The domain checker's use of the fixed list is pinned by the unit spec, not by this e2e.
- The domain checker takes the fixed list's keys from the configuration (Ruling 8's "adds the fixed list's keys"), not from the stored `local` lists, so a pass before the first `registerPublishers` has finished still counts them; `readStoredLists` there still reads the URL publishers only.
- `storeFixedList` compares against the highest-sequence stored `local` list (what `judge` calls newest) with both sides sorted, so a stored list written in any order, or by another version of the code, is compared by its key set.
- YAGNI: no new config, no new table or column, no docs in this task (Task 11 owns the docs); `unlPublishersOf` is unchanged.

## Concerns
- None blocking. Note for the reviewer: the `unl_lists` `local` row's `fetched_at` is the registration time and `effective` its floor, so `listInUse` at a time before the first registration returns that first list as "the oldest stands in" (the same rule as for any publisher); past rounds before the fixed list existed are therefore read with that list, as they are for a publisher whose first list was fetched later.
