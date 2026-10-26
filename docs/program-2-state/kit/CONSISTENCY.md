# Cross-spec consistency pass: explorer program 2

Sixteen specs were drafted in parallel by eight agents from one brief (`SPEC-BRIEF.md`, same folder). Your job: read them all
together, make them agree, and fold the new words into both glossaries. You edit the specs in place; you don't redesign features.

## Files

DAPI = `/Users/golobitch/github.com/GateHubNet/data-api-worktrees/explorer-data-2`, EXP = `/Users/golobitch/github.com/GateHubNet/x-explorer-worktrees/explorer-pages-2`.

| Pair | DAPI spec (`docs/superpowers/specs/`) | EXP spec (`docs/superpowers/specs/`) |
|---|---|---|
| env | `2026-10-24-testnet-profiles-design.md` | `2026-10-24-sandbox-environment-design.md` |
| NFTs | `2026-10-17-nft-data-design.md` (revised) | `2026-10-24-nft-pages-design.md` |
| names | `2026-10-24-display-names-design.md` | `2026-10-24-display-names-design.md` |
| objects | `2026-10-24-ledger-objects-delegation-design.md` | `2026-10-24-ledger-object-pages-design.md` |
| tokens | `2026-10-24-issued-tokens-design.md` | `2026-10-24-token-pages-design.md` |
| supply | `2026-10-24-supply-design.md` | `2026-10-24-supply-page-design.md` |
| validators | `2026-10-24-validator-toml-details-design.md` | `2026-10-24-validators-map-design.md` |
| MPT | `2026-10-17-mpt-data-design.md` (revised) | `2026-10-24-mpt-page-design.md` |

Build order: env (D-env, E7), NFTs (D3, E8), names (D4, E9), objects (D5, E10), tokens (D6, E11), supply (D7, E12), validators (D8,
E13), MPT (D9, E14). A spec may rely only on specs built before it; anything a later spec needs from an earlier one must be defined
in the earlier one (or the later one adds it as an extension, saying so).

`PROGRESS.md` (same folder) summarises every drafter's report: decisions, dependencies, proposed glossary terms. Read it first.

## Known conflicts to resolve (rule, then edit both sides)

1. **Toml store column**: D8 assumed the store's version column is `fetched_at`; D4 defines `checked_at`. Fix D8 (and E13 if it
   mentions it) to D4's names; check every other D4 interface name D6 and D8 use (`domain_tomls`, `account_domains`,
   `readStoredTomls`, `DomainTomlsService`, `cleanTomlText`, `countsOn`, `recordToml`, `nextTomlRow`, `accountDomainOf`) against D4.
2. **MPT amount shape vs build order**: D5 says it depends on D9's MPT amount representation and E10 waits for E14's `MptAmount`, but
   D5/E10 are built before D9/E14. Ruling: the MPT amount shape (in the data API's parsed/served amounts) and a minimal explorer
   `MptAmount` (issuance ID + integer value, rendered raw with a link to the MPT page) are defined in D5 / E10; D9 / E14 extend them
   (scale, ticker via the `?ids=` batch). Edit all four specs accordingly.
3. **Coverage service**: D3 defines `FeatureCoverageService` and the `coverage` shape; D6 and D7 need a "no amendment" case
   (coverage from the network's first ledger); D-env says enable ledgers come from the amendments data, never constants, and
   testnets answer `complete: false`. Put the no-amendment case and the amendments-data rule in D3 (the first to build it) and make
   D5, D6, D7, D9 reference it rather than define it. Check every spec's placement of `coverage` in its answers (D6 puts it right
   after `result`): one rule for all new endpoints, stated in D3.
4. **Parser-version gates**: NFT_PARSER_VERSION (D3), OBJECT_PARSER_VERSION (D5), TOKEN_PARSER_VERSION (D6), MPT_PARSER_VERSION (D9);
   D7 adds Xahau mint tables that need a reprocess — it needs a gate too (name it). D4/D8 add no ledger-derived tables? Verify.
   No spec may assign a concrete number (the plans do); fix any that do.
5. **Header nav across E8, E11, E12, E13**: who adds what and in which order. E8 adds "NFTs" (if not already in the nav — check the
   code), E11 "Tokens", E12 turns "Network" into the disclosure menu (Overview, Validators, Amendments, Supply), E13 adds nothing.
   The final order must match the boards (Ledgers, Transactions, Accounts, Tokens, Network▾, Markets, AMM, NFTs) minus unbuilt
   items. Make the four specs agree and say which spec owns each step.
6. **Search across E8, E10, E14**: E8 (64-hex: transaction, ledger, NFT, then node), E10 (`/v2/ledger_objects/{id}`), E14 (48 hex →
   MPT). The order of lookups must be one sequence, defined in E8 and extended (not redefined) by E10 and E14.
7. **Names in later pages**: E10, E11, E13, E14 must use E9's helpers by E9's exact names (`collectAddresses`, `loadNames`, the
   `AccountLink` props); check E9 defines them so.
8. **Switches**: `NFTS`, `NAMES`, `LEDGER_OBJECTS`, `DELEGATION`, `TOKENS`, `SUPPLY`, `VALIDATORS_MAP`, `MPT` — same spelling and
   the same rule everywhere; E7's sandbox values; E10's "Sent by shown whatever DELEGATION says" is fine if stated as a rule.
9. **Words**: both glossaries (DAPI `GLOSSARY.md` from PR #20; EXP `GLOSSARY.md`). Watch for: token "supply" (D6/E11) vs the native
   currency's "total supply"/"circulating supply"; MPT "outstanding amount" vs "supply"; "locked" (MPT issuer lock) vs "escrowed";
   NFT "owner" vs token "holder"; "removed" objects; "fee payer"; "minted"; "account reserves"; "display name" family.
   Make the specs use the glossary words consistently.
10. **New ADR numbers**: PR #20 has ADR-0014 and 0015. D4 (names), D6 (tokens) want new ADRs, D8 amends ADR-0012. Don't number them
    in the specs (write "a new ADR"); the plans number them.
11. **Routes**: check each explorer spec links to the routes other explorer specs define with the exact same shapes (e.g. token
    URLs `/{net}/token/{currency}.{issuer}`, MPT `/{net}/mpt/{issuanceId}`, NFT `/{net}/nft/{id}`, objects `/{net}/escrows/{id}`
    etc., `/{net}/supply`), and each data API path used by an explorer spec exists in a data API spec with the same params.

Look for further conflicts of the same kinds (a name defined twice differently, an interface used before it's built, a route or
field spelled two ways, contradicting decisions) and resolve them the same way: the earlier spec in build order defines, later ones
reference; a ruling that changes a decision row goes into that spec's "Owner decisions to confirm" table.

## Glossaries

Add the proposed terms from `PROGRESS.md` to the right glossary, in each file's existing format and sections (definition, then
`_Avoid_:`). Product words go in both (the explorer's is the product glossary; the data API's gains the ledger/feature terms its
specs use, e.g. Escrow, Check, Payment channel, Delegation, Delegate, Permission copied from the explorer's); internal-only terms
(token generation, state touch, toml store, supply snapshot) only in the data API's. Update DAPI's Network/Environment entries per
the env spec (the sandbox runs testnets). Keep definitions one or two lines, no implementation detail.

## Rules

- Edit only the 16 specs and the two `GLOSSARY.md` files. No commits, no builds, no other files. No subagents.
- Keep each spec's structure; make minimal edits. Where two specs disagree and neither the brief nor build order settles it, pick
  the simpler rule and record it as a row in the affected specs' decisions tables.
- Report (final message, under 400 words): each conflict found and how you resolved it (one line each), any you could not resolve
  (needs the owner), and the glossary terms added per file.
