# E7 final fix wave: four Minor findings of the whole-branch review

Branch `feat/explorer-pages-2`, from HEAD `63e15f7`. Three commits, none amended, nothing pushed.

| Commit | Findings |
|---|---|
| `1667652` docs(sandbox): the reset runbook keeps its suffix, and noindex is on what the Worker serves | 1, 3 |
| `8d9dff1` refactor(sandbox): the validators table rows no longer carry unlPublishers | 2 |
| `49634e6` refactor(sandbox): one networkInfoOf for the four validators and amendments loaders | 4 |

Findings 1 and 3 share `README.md`, so they are one commit (the index cannot be split by hunk without the interactive `-p`).

## 1. Reset runbook (README.md, "A testnet reset")

The sentence "so nothing of the old chain is read again" is now "so a deploy under the new id does not read the old chain's entries; they expire by themselves".
A new sentence says the keys hold the build id and nothing else of the deploy, so every sandbox deploy after reset *n* keeps the `-reset<n>` suffix, until the next reset
brings `-reset<n+1>`; a deploy under a plain build id (a redeploy or a rollback of a commit that was on the sandbox before the reset) would read that id's entries again:
the old chain's ledger pages, CTID redirects and subrequests, for up to a year.

## 2. `ValidatorRowView.unlPublishers` removed (dead data)

- `app/server/validators-view.ts`: the field, its doc comment (the stale "hidden words of the UNL tag") and its line in `rowView` are gone. `publisherLabel` stays imported: the "Listed by" select uses it.
- `app/server/validators-view.test.ts`: the two `unlPublishers` expectations in "names a validator by its domain…" are removed and replaced by one `not.toHaveProperty("unlPublishers")` on a row; the third (in "labels local Fixed list in the select and on a row") is removed and the title is now "…in the select" (the row's words for the fixed list stay pinned by the next test, through `listedBy`).
- `app/server/validator-view.ts`: the doc comment of `identity.unlPublishers` no longer calls it "the hidden words of the UNL tag"; it says it is the membership line when S did not load, and that the UNL tag reads `listedBy`. `identity.unlPublishers` itself stays (ValidatorPage.tsx uses it).
- No README or UI file mentioned the row's field (grep over `app`, `test`, `workers`, `scripts`, `README.md`; the plans under `docs/` keep their words).

TDD:
- RED: `pnpm vitest run app/server/validators-view.test.ts` failed 1 of 83: `AssertionError: expected { …(14) } to not have property "unlPublishers"`, received `["unl.xrplf.org", "vl.ripple.com"]` (expected: the field was still there).
- GREEN: after the removal the same file passes (part of the run below).

## 3. "Every response" overstated

"Every response the Worker serves" in the module docstring of `app/server/environment.ts` (which also says the static files, `/assets/*` and `/favicon.ico`, are served by Cloudflare's asset layer before the Worker and get nothing) and in
README.md at the three places named by the review (the sandbox constraints list, "Robots in the sandbox", where a sentence now names the static files and says they carry no header) and, for the same claim, at three more places that said it
in the same words: the `pnpm dev` paragraph ("answers every response the Worker serves with…"), the file table row of `environment.ts`, and "The sandbox." in the deployment section ("no page in it is indexed (… on every response the Worker serves)").

## 4. `networkInfoOf`

`app/server/network-route.ts` has `networkInfoOf(net: Network): NetworkInfo`, next to `publicNetwork`; it returns `{ id, kind, name, label, longName, dexName, native, software }`. `NetworkInfo` is a type-only import from
`app/ui/networks.ts` (it already imports `PublicNetwork` from this file as a type), and the file is server-only, so the rule of no browser value import from `app/server` is untouched. Used in `net.amendments.tsx`, `net.amendments.$name.tsx`,
`net.validators.tsx` (the by-hand destructure replaced) and `net.validators.$key.tsx` (its local `publicOf`, used twice, removed).

TDD:
- RED: `pnpm vitest run app/server/network-route.test.ts` failed 2 of 27: `TypeError: networkInfoOf is not a function` (expected: not written yet). The two tests: the mainnet XRPL `toStrictEqual` the eight fields, and the sandbox's Xahau Testnet likewise, with `JSON.stringify` not containing the placeholder host (no URL).
- GREEN: 27 of 27 pass.

## Verification

- Focused: `pnpm vitest run app/server/network-route.test.ts app/server/validators-view.test.ts app/server/validator-view.test.ts` — 3 files, 181 tests passed.
- `pnpm verify` — exit 0: api:check, typecheck, test (218 files, 10001 tests passed), build, check:bundle passed (validators 149.3 KB of 160, validator 149.7 KB, amendments 139.6 KB, amendment 148.2 KB; unchanged in kind, the change removes a field from a payload and adds no client code).
- `pnpm fixtures:check` — "1051 generated fixture files are up to date".
- `pnpm test:e2e` — exit 0: 555 passed, 11 skipped (the `.data` payload of the validators page changed, so the suite was run). The `[ERROR]` lines in its output are the expected logs of the failed-card scenarios.
- No worker-project timeouts happened.
- Not run: a formatter check (`prettier` is not a dependency of this repo; the files follow the surrounding style by hand).

## Self-review

- Diff touches only the files the findings need: README.md, environment.ts, validators-view.ts and its test, validator-view.ts (a comment), network-route.ts and its test, the four loaders.
- Beyond the named line numbers of finding 3, three more README sentences repeated the same overstatement and were corrected in the same words, so the README does not contradict itself.
- No `.claude/` touched, nothing deleted, files named in every `git add`.

## Concerns

None.
