## Task 1 review (BASE 5294876, HEAD a82875a)

### Spec Compliance
- ❌ Issues found (one, needs a controller ruling):
  - Step 1 says a case not found "within 50,000 ledgers" goes to Not found and becomes a synthetic transaction. `offer_removed_other` was declared not found after 19,955 ledgers (40% of the window). The scan was stopped by the node's load limit: FINDINGS.md:25 (xrpl/nft), README.md:286, commit body. The shortfall is disclosed everywhere, but the condition of the plan's fallback is not met. See Important #1.
- Everything else matches the brief:
  - All 16 XRPL and 9 Xahau case names are accounted for. Found cases are in `manifest.cases` as `{ledger, hash, type, note}`. The two not-found names are exactly the ones the FINDINGS "## Not found" sections list, and the test pins that match (`nft-fixtures.spec.ts:214-218`, my line numbers from the working tree).
  - The extra `burn: {ledger, hash}` on `uritoken_remint` is additive and documented (README, spec lines 253-263 in the file). Its ledger is recorded and counted by the "ledger once" test.
  - File list matches the brief: both directories hold the ledgers, `manifest.json`, `server_definitions.json`, `server_info.json` and `FINDINGS.md`. There is also the spec file and two README rows plus a section per set. Nothing extra is in the diff.
  - The commit message follows the repo form and has a body.
  - Step 4's five tests are present. The sixth (`shows what the case is for`) is an extra, and it is what makes the cases checked rather than merely named.
  - Every FINDINGS fact the brief lists is present, each with how it was checked: page-key owner (fact 2), taxon unscrambling (3), brokered and direct royalty (4, 5), ids from page diffs (1). For Xahau: the `URITokenBuy` price (2), `Remit` owner change (3) and the first-ledger facts (1, with all the required values).
- ⚠️ Cannot verify from the diff (network-dependent):
  - The `account_nfts` check for 3 owners, the `nft_info` check, the Xahau `ledger_entry`/`server_info` checks, the 290 `account_info` calls, and the scan counts (4.1 million transactions; 24,474 buys; 14,211 mints).
  - Xahau scan coverage: 17,072 of 49,999 ledgers (34%, the Evernode bursts) were never read, only counted by hash. The Xahau not-found claims (`uritoken_mint_with_offer`, and "no buy above the ask") therefore rest on 32,927 read ledgers plus `account_tx` of the marketplace accounts. FINDINGS states this accurately; the controller should decide whether it counts as "50,000 ledgers" for Task 5's synthetic.

### What I verified myself (offline, on the recorded ledgers, scripts in the scratchpad)
- XRPL, over all 11 ledgers:
  - 12 successful mints; in each, the pages gain exactly one id and lose none.
  - Taxon, issuer, fee and flags decode correctly from the id for all 12. 11 have a non-zero taxon. All 12 serials are above 2^24, not just one as fact 3 says.
  - Page owner equals the minter, including `mint_on_behalf`.
  - 26 modified pages, 1 of them with only `NextPageMin` in `PreviousFields`.
  - No `nftoken_id`, `offer_id` or `nftoken_ids` key anywhere.
  - The `brokered_sale_royalty` balance changes match fact 4 exactly: issuer +4428495, seller +143188005, broker +2383470, buyer -150000000, fee 30.
  - `sale_by_sell_offer` matches fact 5: issuer +500000, seller +9500000, buyer -10000012. `sale_by_buy_offer` matches: issuer -11.
  - `sale_issued_currency` has the issuer as seller. In `transfer_zero_amount` the deleted offer's `Amount` is "0".
  - The page and token counts in the notes (20 was 19; 23 to 22; 16 to 15; modify 18; split 32 to 16 + 17 with an untouched neighbour) all hold.
- Xahau:
  - The buy at exactly the ask: `PreviousFields.Amount` equals the tx `Amount` equals the seller's gain, and the buyer lost 4200026810.
  - `remit_transfer` and `remit_mint` match fact 3, including the balance deltas of 200000 and -229607.
  - The `uritoken_remint` created index equals the burn's deleted index.
  - Ripple-time 751983660 is 2023-10-30T12:21:00Z.
- The focused spec run is 53/53 with no warnings or noise. Prettier is clean on the spec, manifests and FINDINGS. README.md fails `prettier --check`, but it already did at BASE and `pnpm format` only covers `src/**/*.ts`.
- The recorded file sizes match the README's totals: 0.90 MB for 11 XRPL ledgers and 93 KB for 9 Xahau.
- Spec consistency: no FINDINGS fact contradicts the design spec (royalty on price less broker fee, the brokered price is the buy offer's `Amount`, the taxon formula, the page-key rule, `URITokenBuy` sending the tx `Amount`). Two findings refine the spec and Task 3/4 must take them up:
  - FINDINGS fact 6 (xrpl): a zero `Amount` is absent from the `NewFields` of a created `NFTokenOffer`. Spec §2.2 says offers carry "amount" without this caveat.
  - FINDINGS fact 7 (xrpl): a neighbour page after a split has no previous `NFTokens`. Spec §0 says "Previous arrays are in PreviousFields".

### Strengths
- The hard cases were found by condition, not by `--want`. The one weak first pick, a `sale_by_sell_offer` where the issuer was the seller and so paid no royalty, was caught and swapped for a third-party-issuer sale. The README says so.
- The spec file pins the real metadata condition of each case (`nft-fixtures.spec.ts:96-189`), with helpers modelled on the node shapes. Examples:
  - `directSale` requires one accepted offer of the named side with a non-zero string `Amount`.
  - The brokered check requires both offers, the broker fee, an id fee above 0, and an issuer that is neither party.
  - The remint check compares the created index, `URI` and `Issuer` against the burn's deleted node.
- FINDINGS is candid about weak cases: all mints with offers carry `Amount` "0", direct buy-offer sales are always 1 drop, and no above-ask buy exists. Each is a fact a downstream task needs.
- The FINDINGS royalty and balance arithmetic checks out against the fixtures, and the taxon check includes the above-2^24 precision trap.
- No synthetic data is passed off as recorded. Each not-found case is flagged for its later task.

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)
1. xrpl/nft `FINDINGS.md:25`, `README.md:286`: `offer_removed_other` was declared not found after 19,955 ledgers; the plan requires 50,000 before the synthetic fallback (Task 1 Step 1).
   - Why it matters: Task 4 will build a `synthetic-…` transaction on a weaker search than the plan's trigger.
   - How to resolve, controller's choice:
     - (a) Finish the window: another ~30,000 ledgers below 107866493, `--delay-ms 75`, against `https://s1.ripple.com:51234/` or `wss://xrplcluster.com` (the README already records a recording from the latter), then update the counts and the two texts. Or run a targeted `AccountDelete` search.
     - (b) Accept the shortfall explicitly as a controller ruling next to C8. FINDINGS and README then already say what was done.

#### Minor (Nice to Have)
1. `xrpl/nft/FINDINGS.md:3` and the commit body give validated head 107917324 (the first run). `manifest.json`, `server_info.json` and README.md:251 give 107918450 (the second run, which produced the committed manifest). Say "two runs, heads A and B" in FINDINGS. The commit message cannot be amended, so correct it in the README or FINDINGS only.
2. `xahau/uritoken/FINDINGS.md:3` says "10 transactions". The manifest `txs` and the recording command list 9 (8 cases plus the burn). Fix to 9.
3. `xrpl/nft/manifest.json:96` (case `mint`) note starts "NFTokenMint by rpvC5…(ravC5cZreMZuKEWSrpra5nkWnfzPmrabec)". The abbreviation `rpvC5…` matches nothing; the real account is `ravC5cZre…`. Remove the prefix.
4. `xrpl/nft/manifest.json:176` (case `page_split_with_mint`) and its README row do not say that this mint also creates an `NFTokenOffer` (`Amount` "0", a gift offer; metadata is Ticket deleted, offer created, 3 pages). Task 4's expected events for this case will include an `offer_create`. Add it to the note.
5. `xahau/uritoken/FINDINGS.md` fact 2: "The `URITokenBuy` price is the transaction's `Amount`, paid to the seller" is stated as checked. The only buy recorded has `Amount` equal to the ask, so the check cannot tell whether an overpayment pays the `Amount` or the ask. The spec asserts it from the xahaud source. Reword to say what was observed (`Amount` equals the ask equals the seller's gain) and that an overpayment was never seen.
6. `nft-fixtures.spec.ts:123`, `:126`, `:155`: `modify`, `offer_cancel` and `uritoken_sell_offer_cancel` have `() => true`, so `shows what the case is for` asserts nothing for them beyond the type and result already tested. Their notes claim a URI-only change, a deleted offer with no page change, and a cleared `Amount`. Cheap pins:
   - `modify`: a `NFTokenPage` whose `NFTokens` differ in `URI` only.
   - `offer_cancel`: a deleted offer.
   - `uritoken_sell_offer_cancel`: `PreviousFields.Amount` present and `FinalFields.Amount` absent.
7. `nft-fixtures.spec.ts:157-161`: `uritoken_buy_above_ask` switches between "above the ask" and "at the ask" by testing the prose of the note (`/exactly the ask/`). A reworded note flips the assertion. Make the mode explicit (a manifest flag, or require `>=` always and assert the fallback elsewhere). `expect(...).toBe(true)` on a boolean predicate (line 250) gives a bare "expected true" on failure; returning a description would make a re-recording failure readable.

### Assessment
**Task quality:** Needs fixes (one controller decision on Important #1, plus the small text corrections in Minor 1-5). Approve once the XRPL scan shortfall is either closed or ruled acceptable.
**Reasoning:** The recorded data, the manifests' cases and the spec's pinned conditions are correct. I re-derived the FINDINGS facts that can be checked offline from the committed ledgers, and they match; the 53 tests pass cleanly. The only substantive gap is the XRPL not-found search covering 40% of the window the plan requires. The rest is wording and test-strength polish.