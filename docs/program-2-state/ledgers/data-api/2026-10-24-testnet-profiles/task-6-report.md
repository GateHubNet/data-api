# Task 6 report: `GH_UNL_VALIDATORS` and `GH_UNL_PUBLISHERS=default`

Status: DONE. Commit `99fc706` feat(syncer): GH_UNL_VALIDATORS, a validator list fixed in the configuration (base 3035a5c).

## What was implemented

- **Recording (Step 1).** `pnpm record:fixtures -- --unl --network xrpl-testnet` (2026-10-25 01:11 UTC) wrote
  `packages/shared/test/fixtures/xrpl-testnet/unl/vl.altnet.rippletest.net.json` (3790 bytes, version 1, one blob, sequence 59, 6 validators,
  blob expires 2027-08-07T17:31:06Z, no `effective`, no `refresh_interval`; it verifies with the profile's key and the 6 validator manifests all
  decode and name their own master key). Provenance is in `packages/shared/test/fixtures/README.md` (directory table row, "UNL lists" heading,
  a table and a paragraph; Xahau Testnet has no list to record).
- **Shared (`unl-publishers.ts`).** `LOCAL_PUBLISHER_ID = 'local'`; `parseUnlValidators(text)` (trim, skip empty entries, each must decode
  with `decodeNodePublic`, no repeats, order kept, `GH_UNL_VALIDATORS entry <n>: must be a validator public key (n…)` / `repeats a key`,
  `n` over the non-empty entries); `parseUnlPublishers` refuses an id that is `local` in any case (`the id "local" is reserved`).
  Already exported from `src/index.ts` and `src/network/index.ts` through the existing `export *`.
- **Syncer config (`syncer.config.ts`).** `MaybeEmptyText(fallback?, { defaultWord })` (`default`, any case, trimmed, takes the fallback);
  `unlPublishers` uses it; new `unlValidators!: string` (`GH_UNL_VALIDATORS`, after `unlPublishers`) with `defaultUnlValidatorsOf` and
  `IsUnlValidators`; `unlValidatorsOf`, `unlListCount` (publishers + 1 when the fixed list is not empty), `unlThresholdOf` over `unlListCount`;
  `IsWithinPublishers` bounds `GH_UNL_THRESHOLD` by `unlListCount` with `... the number of lists (<n>)`, and stays silent when either list setting
  cannot be read (reported alone). `tryParsePublishers` was replaced by one small `refusalOf(parse, text)` helper used by both list validators.
- **Types only (controller ruling P3).** `UnlConfig` of `unl-fetcher.ts`, `loadListContext`'s `cfg` (`stored-lists.ts`), `rounds.job.ts:124`,
  `agreement.job.ts:159` add `'unlValidators'`. `loadListContext` behaviour is unchanged (Task 7 adds `local` to its publishers).
- **Test fixtures.** `unlValidators: ''` added to `apps/syncer/test/support/validators-env.ts` (default config), `compute-jobs.spec.ts`,
  `domain-checker.spec.ts`, `unl-fetcher.spec.ts`, `validators.module.spec.ts`, and `test/validators.e2e-spec.ts` (the two
  `Object.assign(new SyncerConfig(), …)` at ~1860 and ~3448: `new SyncerConfig()` leaves `unlValidators` undefined, which `unlValidatorsOf` would
  parse and crash on).
- **Docs.** `docs/configuration.md`: §1 list (`GH_UNL_VALIDATORS` where empty means "off" and the `default` word), `GH_NODE_ENDPOINTS` row (testnet
  defaults), `GH_UNL_PUBLISHERS` row (`default`, XRPL Testnet default, Xahau Testnet none, reserved id `local`), a new `GH_UNL_VALIDATORS` row,
  `GH_UNL_THRESHOLD` row (bound is the number of lists, new message, testnet counts). `apps/syncer/.env.example`: commented rows for both
  variables with the XRPL Testnet and Xahau Testnet defaults, threshold comment.

## Tests

New/changed cases (all from the brief, plus a few boundary ones):
- `unl-publishers.spec.ts`: XRPL Testnet default publisher; Xahau Testnet none; the fixed list of Xahau Testnet; no list on the other networks;
  empty text; trim/skip/order; the three brief refusals, plus repeat counted over non-empty entries, a bad checksum, an `r…` address; reserved
  `local` (any case, entry number, `local.example` accepted).
- `unl-list.spec.ts`: the recorded testnet list added to `RECORDED` (verifies with XRPL Testnet's key, version 1, one blob, 6 validators, expiration,
  verifies with its own manifest as the known one).
- `syncer.config.spec.ts`: `default` / `DEFAULT` / ` Default ` for `GH_UNL_PUBLISHERS` on all four networks; XRPL Testnet publisher and Xahau Testnet
  none; `default` only as the whole value; reserved `local` at boot; `GH_UNL_VALIDATORS` unset / default / empty / list / other networks / bad entries /
  repeats / reported alone; threshold bounds with the lists (`(2)`, `(1)`, `(0)`, `(3)` and the Xahau Testnet `(1)` case) — the three existing
  "publishers" assertions (including the `(0)` one) now say "lists"; `unlListCount` (xahau-testnet 1, xrpl 2, xrpl + K0 3, emptied 0);
  `unlThresholdOf` (xahau-testnet 1, with the fixed list in rippled's rule); defaults test pins `unlValidators: ''`.

TDD evidence:
- RED (shared): with `unl-publishers.ts` restored to HEAD,
  `pnpm test -- unl-publishers unl-list` (in `packages/shared`) failed: `TS2305: Module '"./unl-publishers"' has no exported member
  'LOCAL_PUBLISHER_ID'` / `'parseUnlValidators'` (expected: not yet implemented). The recorded-list case of `unl-list.spec.ts` passed already
  (it needs only the fixture from Step 1).
- RED (syncer): `pnpm --filter @gatehub/data-syncer test -- syncer.config` failed to compile: `has no exported member 'unlListCount'` /
  `'unlValidatorsOf'`, `Property 'unlValidators' does not exist on type 'SyncerConfig'` (expected).
- GREEN: shared `pnpm test -- unl-publishers unl-list`: 2 suites, 114 tests passed. Syncer `-- syncer.config`: 71 tests passed (one assertion needed
  the JSON-escaped quotes the ConfigService prints for `"local"`; fixed in the test).

Full verification before the commit (all exit 0):
- `pnpm build` (shared, exporter, api, syncer).
- `pnpm test`: shared 1682, exporter 12, api 1852, syncer 1311 tests passed; no warnings in the output.
- `pnpm --filter @gatehub/data-syncer test:e2e` (whole suite, includes `validators`): 13 suites, 335 tests passed.
- `pnpm --filter @gatehub/data-api-shared test:e2e`: 15 suites, 876 tests passed.
- Prettier check on every changed `.ts` file: clean. The README of the fixtures and `docs/configuration.md` were not run through Prettier (they already
  differ from it; running it rewrote unrelated tables, so I reverted that and hand-aligned my table).
- The api package has no changed file, so its e2e was not run.

## Self-review

- Brief complete: Step 1 recording and provenance, parser, reserved id, config property, decorators, three functions, type widenings, `.env.example`,
  docs (§1, §5 rows), spec cases. The controller's ruling P3 callers are covered.
- The controller message names `apps/api/test/validators.e2e-spec.ts`; the callers at ~1860 and ~3448 are in `apps/syncer/test/validators.e2e-spec.ts`
  (the api file has none), so that is the file I changed. The "(0)" wording is in `apps/syncer/src/config/syncer.config.spec.ts` (the plan's "spec's
  line 411" is that spec; the design spec has no such wording).
- YAGNI: `loadListContext` does not add `local` (Task 7 owns it, with its test); no compose or `.env` sandbox changes (Task 10).

## Concerns

- None blocking. Docs left for later tasks: compose section rows of `docs/configuration.md` (`XRPL_UNL_PUBLISHERS` ... "compose never passes an empty one on",
  the "passes ... to both" sentence of `GH_UNL_THRESHOLD`) still describe the two-network compose file and belong to Task 10; `.env.example`'s
  `GH_NODE_ENDPOINTS` comment still lists only xrpl/xahau endpoints (Task 11 stale wording list).
- `new SyncerConfig()` has `unlValidators` undefined at runtime (like `unlPublishers`); any test or code that builds a config that way has to set
  `unlValidators`. All current ones do.
