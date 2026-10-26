# Task 9 report: the validators pages and Xahau Testnet's fixed list

Status: DONE_WITH_CONCERNS. Commit `d9a78ff feat(sandbox): Xahau Testnet's fixed validator list reads "Fixed list"` on `feat/explorer-pages-2` (not pushed).

## What I implemented

- `app/domain/publishers.ts` (new): `LOCAL_PUBLISHER = "local"`, `publisherLabel(id)` ("Fixed list" for `local`, the id otherwise), `listedByText(ids)` (`""` | `on the fixed list` | `listed by A and B` | `listed by A and on the fixed list`; the fixed list is always last, whatever its place in `ids`; three or more read `listed by A, B and on the fixed list`).
- `app/server/validator-facts.ts`: re-exports those three (like `joinAnd` and `statusWord`), and adds `unlIntro(network, publisherIds)`: mainnet `... validators ${software} trusts out of the box<source>.`, testnet `... validators the nodes of ${name} trust<source>.`; `<source>` is `, published by A and B`, `, fixed in their configuration` (local alone), `, published by A and fixed in their configuration` (both) or empty.
- `app/server/validators-view.ts`: the intro is `${unlIntro(network, ids)} All adds every other ...`; the "Listed by" options are `{ value: id, label: publisherLabel(id) }`; a row's `unlPublishers` are labels; the UNL tile's sub-line is `seen in 24 h, of those ${listedByText(ids) || "listed"}`; `noticesOf` filters `local` out first (no notice, and it is not one of the lists the "No validator is trusted until one is." sentence counts). The filter still matches on ids (`?publisher=local`).
- `app/server/validator-view.ts`: `identity.unlPublishers` and `membership[].publisher` are labels (`listed` still follows the id). `meta.publishers` stays ids (controller ruling C4); the comment says why.
- `app/server/meta-validator.ts`: writes `, on the default UNL (${listedByText(publishers)})`. Mainnet text is unchanged ("listed by ...").
- `app/server/validators-shape.ts`: a publisher's `id` is checked with `isName`; `url` and `public_key` with a new `isText` (a string, may be empty). No `expiration` was already optional.
- `test/unit/validators-bundle.test.ts`: `domain/publishers.ts` added to the list of browser files that must not value-import `app/server` or `ripple-*`.

## Deviation from the brief's file list (please check)

The brief puts `listedByText` in `validator-facts.ts` and has `meta-validator.ts` call it. But `meta-validator.ts` runs in the browser (a client-side navigation builds the tags), and `test/unit/validators-bundle.test.ts` and `test/unit/meta-bundle.test.ts` forbid it to value-import anything of `app/server` but `./meta`; `validator-facts.ts` value-imports `ripple-address-codec`. Following the plan to the letter would have failed `pnpm test`. I used the repo's existing answer for the same problem (`joinAnd` in `time-words.ts`, `statusWord` in `amendments-params.ts`, both re-exported by `validator-facts.ts`): the three small publisher words live in a new domain file, `app/domain/publishers.ts`, and `validator-facts.ts` re-exports them, so the interface the plan names (`validator-facts.ts` exports `LOCAL_PUBLISHER`, `publisherLabel`, `listedByText`, `unlIntro`) holds, and the plan's tests import them from `validator-facts`. `unlIntro` stays in `validator-facts.ts` (Worker only). I did not give `publishers.ts` its own test file: the plan's tests run through the re-export, and `validator-facts.test.ts` has an identity check (`toBe`) that the re-exports are the domain functions, like the existing `joinAnd`/`statusWord` check.

## TDD

RED (tests written first; `pnpm test app/server/validator-facts app/server/validators-shape app/server/validators-view app/server/validator-view app/server/meta.test`): 5 files failed, 7 failed tests of 538:
- `validator-facts.test.ts`: suite failed to load, `Cannot find module '../domain/publishers'` (the helpers did not exist).
- `validators-shape.test.ts` "accepts the fixed list local, with an empty url and public_key and no expiration": `UpstreamError: data API GET /x answered something unexpected: unl.publishers[0].url is not text` (the plan's expected failure: an empty `url` refused).
- `validators-view.test.ts`: "labels local Fixed list ...", "gives local no notice, with any status", "says 'of those on the fixed list' ...", "writes the testnet intro" failed (ids not labels, notices for `local`, "software trusts out of the box" on a testnet).
- `validator-view.test.ts` "names local Fixed list in the membership line and the UNL tag": received `"local"`, expected `"Fixed list"`.
- `meta.test.ts` "words a validator on Xahau Testnet's fixed list ...": received `(listed by local)`, expected `(on the fixed list)`.
- Passing already (pins of existing behaviour): "still refuses a publisher whose url is not text", "still filters by the id local, not by its label".

GREEN: same command after the implementation: 5 files, 681 tests passed.

## Verification

- `pnpm verify` exit 0: `api:check`, typecheck, `Test Files 217 passed, Tests 9969 passed`, build, `check:bundle` ("bundle check passed"; validators 149.3 KB of 160, validator 149.5 KB of 160).
- `pnpm fixtures:check`: 1051 generated fixture files are up to date.
- `pnpm test:e2e` exit 0: 555 passed, 11 skipped (the `[ERROR]` lines in its output are the failing-card fixtures logging, as expected).
- After the last comment-only edit I re-ran the validator, meta and bundle unit tests (745 passed) and `tsc -b`.
- No worker-project spec timed out.

## Tests added

`validator-facts.test.ts`: labels the fixed list; says who lists; puts the fixed list last and keeps a comma list; words the intro per kind; words the intro for a fixed list beside published ones and for none; re-export identity. `validators-shape.test.ts`: accepts the fixed list; still refuses a non-text url; still refuses a non-text or missing `public_key`, a missing `url`, an empty `id`. `validators-view.test.ts`: labels in the select and on a row; filters by id; no notice with any status; tile sub-line (local alone, local beside another); testnet intro (XRPL Testnet, Xahau Testnet, without S). `validator-view.test.ts`: membership and `unlPublishers` (alone, beside a published list, without S, history page); `meta.publishers` keeps ids. `meta.test.ts`: the description on Xahau Testnet ("on the default UNL (on the fixed list)") and on a testnet's published list.

## Self-review

- Completeness against the brief: all three functions, all uses listed in "Uses", the shape check, every test the brief names (plus the extras above). Mainnet texts unchanged (existing mainnet tests untouched and green).
- `prettier` is not installed in this repo (`pnpm exec prettier` not found), so nothing was formatted; I kept the file's long-line style.
- No `.claude/` touched, no amend, files named in `git add`.

## Concerns

1. The deviation above (new `app/domain/publishers.ts`, and one line in `validators-bundle.test.ts`).
2. `UnlTag` (`StatusMarks.tsx`, out of this task's files) joins the labels it is given, so the hidden/title words on the testnet read "Listed by Fixed list". That is what the brief's `unlPublishers: ["Fixed list"]` produces; improving it would need the tag to take ids.
3. The amendment page (`amendment-view.ts`, out of scope) still builds its tally line from publisher ids ("..., on local" on Xahau Testnet). Spec 7.6 does not list it; probably a follow-up.
4. Literal reading of "not counted in 'No validator is trusted until one is.'": `local` is dropped before the check, so a mixed answer of only unavailable published lists plus an `ok` `local` would still say it. D-env serves `local` alone on Xahau Testnet, so this does not arise; I did not pin that mixed case in a test.
5. `api-types.ts` (not in the file list) still documents `UnlPublisher.public_key` as "66 hex digits"; true for published lists, not for `local`. A comment-only fix for a later docs pass.

---

# Fix report, round 1 (commit `c3d6cbe fix(sandbox): the fixed list reads "the fixed list" on the amendment page and the UNL tag, and is not set in mono`)

The reviewer's findings (concerns 2 and 3 of the first report were real gaps against spec 7.6, plus the mono one) are fixed. Mainnet texts are byte-identical.

## What changed

1. **Amendment page vote head** (Important). `app/domain/publishers.ts` gets `onListsText(ids)`: `on A and B` (as before), `on the fixed list`, `on A and the fixed list`, `""` for none; the fixed list is last and named "the fixed list". `AmendmentPage.tsx`'s `votesHead` builds the tail with it (it no longer imports `joinAnd`). `amendment-view.ts` keeps `summary.publishers` as ids (its tests pin them); I only added a comment saying the page words them with `onListsText`.
2. **UNL tag** (Minor). `publishers.ts` gets `unlTagWords(ids)`: `Listed by A and B` (as before), `Listed by the fixed list`, `Listed by A and the fixed list`, `""` for none. The view builders hand it over: `ValidatorRowView.listedBy` and `ValidatorIdentity.listedBy`. `UnlTag` now takes `{ listedBy: string }` (instead of `publishers`) and draws it as its sr-only text and `title`; empty means just "UNL". `ValidatorsPage` and `ValidatorPage` pass `row.listedBy` / `identity.listedBy`. `joinAnd` is no longer imported by `StatusMarks.tsx`. `unlPublishers` (labels) stays on both views as the plan's interface says (the identity's is still the membership line's fallback without S); the row's `unlPublishers` is no longer read by the UI, I kept it for the contract.
3. **Membership mono** (Minor). `ValidatorPage.tsx`'s `Membership` sets `className="mono"` only when the name is not the fixed list's label (`publisherLabel(LOCAL_PUBLISHER)`), so a published id stays mono and "Fixed list" is plain text, with S and in the no-S fallback line.
- `validator-facts.ts` re-exports `onListsText` and `unlTagWords` with the others; the identity test covers them. Both helpers share one split of `local` from the publishers with `listedByText` (no duplicated split).

## Tests added or changed

- `validator-facts.test.ts`: `onListsText` and `unlTagWords` tables (none, one, two, three published; local alone; published + local; local first), re-export identity.
- `StatusMarks.test.tsx`: `UnlTag` tests take `listedBy`; mainnet words unchanged; "Listed by the fixed list" case; the old three-publisher sentence case moved to the `unlTagWords` table.
- `validators-view.test.ts` / `validator-view.test.ts`: `listedBy` on rows and identity (mainnet "Listed by unl.xrplf.org and vl.ripple.com", none `""`, fixed list, published + fixed).
- `AmendmentPage.test.tsx`: Xahau Testnet head, fixed list alone ("... without a recent vote, on the fixed list") and with a published list ("on vl.altnet.rippletest.net and the fixed list"); the existing mainnet head tests are untouched and pass.
- `ValidatorPage.test.tsx`: membership names (publisher id mono, "Fixed list" not mono) with S and without S; the heading's UNL tag reads "Listed by the fixed list" (sr text and title).
- `ValidatorsPage.test.tsx`: a row's UNL tag on mainnet ("UNL Listed by unl.xrplf.org and vl.ripple.com") and on Xahau Testnet ("UNL Listed by the fixed list", title too).

## Evidence

- Order of work: the implementation of this round was written before its tests, so there is no RED run of the new tests as written. I checked that they bite with a mutation instead: with `names()` in `publishers.ts` returning the ids unchanged and `Membership` back to `className="mono"`, `pnpm test app/server/validator app/ui/components/StatusMarks app/ui/pages` failed 9 tests (the two amendment head cases, the row tag case, both helper tables, the validator-view membership/tag case, both membership cases and the page row tag case); both files were restored from a copy afterwards and the suite is green.
- `pnpm test app/domain app/server/validator app/server/meta.test app/ui`: 95 files, 3792 tests passed.
- `pnpm verify` exit 0: 217 files, 9977 tests passed; `tsc -b` clean; `check:bundle` passed (validators 149.3 KB, validator 149.7 KB, amendment 148.2 KB, all under their budgets).
- `pnpm fixtures:check`: 1051 files up to date.
- `pnpm test:e2e` exit 0: 555 passed, 11 skipped (development pages: no text change; the run is for the global constraint).
- No worker spec timed out.

## Remaining notes

- Concern 4 of the first report (the literal "not counted" reading in `noticesOf`) is unchanged.
- `api-types.ts`' "66 hex digits" comment on `UnlPublisher.public_key` is still loose for `local` (comment only).
