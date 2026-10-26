## Fix report, Task 1 round 1

Commit `ed8edd3` fixes the four minor findings, and the tree is clean. Both corrected FINDINGS.md files are in the commit, named, untouched by me.

**What changed:**
- **Minor 3** (`xrpl/nft/manifest.json`, case `mint`): the note now names `ravC5cZreMZuKEWSrpra5nkWnfzPmrabec` only; the `rpvC5…` abbreviation is gone.
- **Minor 4** (manifest and README row, case `page_split_with_mint`): both now say the mint also carries `Amount` "0" and a `Destination`, so it creates a gift sell `NFTokenOffer`, and that it was sent with a Ticket, which is deleted. The manifest note adds "besides directory and account nodes" before listing the metadata: a deleted Ticket, a created offer and three `NFTokenPage` nodes. I checked this against the ledger first.
- **Minor 6** (`nft-fixtures.spec.ts`): the three `() => true` cases now pin real conditions.
  - `modify`: a modified `NFTokenPage` with a previous `NFTokens` array holding the tx's `NFTokenID`, the same ids before and after, and exactly one changed entry, the `NFTokenID`'s, whose `URI` differs.
  - `offer_cancel`: a deleted `NFTokenOffer` and no `NFTokenPage` node.
  - `uritoken_sell_offer_cancel`: a modified URIToken with `PreviousFields.Amount` present and `FinalFields.Amount` absent.
- **Minor 7** (`nft-fixtures.spec.ts`): `uritoken_buy_above_ask` no longer reads the note's prose. It is a plain condition: the tx `Amount` is at least `PreviousFields.Amount`, and the previous owner's `AccountRoot` balance rose by exactly the tx `Amount`. The case name is unchanged. A price in an issued currency fails with a reason rather than skipping the seller check, since the recorded case is native.
- **Predicate results:** every predicate in both `XRPL_SHOWS` and `XAHAU_SHOWS` now returns `null` when it holds and a short reason when it does not. A small helper `unless(...)` builds these, and the test asserts `toBeNull()`.

**Covering tests and commands:**
- **Mutation check:** I pointed nine cases at the wrong transaction in a scratch copy of the spec and fixtures (the scratch spec is deleted, the copy lives in the session scratchpad), and 17 tests failed with readable reasons, for example "has an Issuer", "no modified NFTokenPage with a previous NFTokens array holds the NFTokenID", "changes an NFTokenPage", "consumed 2 offers, not 1", "no URIToken lost its Amount", "has no Amount", "the mint and the burn have different indexes".
- `pnpm --filter @gatehub/data-api-shared test -- nft-fixtures` output: `Test Suites: 1 passed, 1 total` and `Tests: 53 passed, 53 total`.
- `pnpm --filter @gatehub/data-api-shared test` output: `Test Suites: 50 passed, 50 total`, `Tests: 1736 passed, 1736 total`, `Snapshots: 5 passed, 5 total`.
- `pnpm build` passes for all four projects.
- `pnpm exec prettier --write` on the spec and both manifests: the manifests were unchanged. The `--check` on all three files is clean.

**Status:** DONE

**Commits:** `ed8edd3` test(shared): the NFT fixture spec pins each case's real condition, and two notes are corrected (on top of `a82875a`)

**Tests:** focused spec 53 of 53; full shared unit run 1736 tests in 50 suites, 5 snapshots; `pnpm build` passes; prettier clean.

**Concerns:** none new. `offer_removed_other` stays under Not found per the controller's ruling and nothing was scanned further. Not run: `pnpm format` (it rewrites three unrelated files), the app unit tests and the e2e suites, since only a spec, a manifest and docs changed.