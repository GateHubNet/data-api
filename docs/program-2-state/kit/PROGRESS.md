# Program 2 spec phase — progress ledger
Worktrees: DAPI=/Users/golobitch/github.com/GateHubNet/data-api-worktrees/explorer-data-2 (feat/explorer-data-2 from origin/feat/account-investigation-data @ bea2bc9)
           EXP=/Users/golobitch/github.com/GateHubNet/x-explorer-worktrees/explorer-pages-2 (feat/explorer-pages-2 from origin/master 075e92c + glossary 973115f)
Overview: EXP/docs/superpowers/specs/2026-10-24-explorer-program-2-overview.md (constraints section to fill)
Glossary terms to add (explorer GLOSSARY + data-api GLOSSARY) — collected per report below.

## A NFTs (D3 586 lines revised in place; E8 461 lines) — DONE
- D3: NFT_PARSER_VERSION gate; nft_daily dropped (collection stats at read time ≤366 d); nft_volume on existing volume jobs (day/7day/30day);
  new tables nft_touches, nft_collection_holders; /holders route; NFT detail at read time; collection key issuer+taxon (XRPL) / issuer (Xahau);
  royalty on price minus broker fee; URITokenBuy price = Amount; converted prices only with D2 daily rate; coverage service NEW & SHARED (D5, D6, D9 reuse).
- E8: routes /{net}/nfts, /{net}/nfts/sales, /{net}/nfts/{issuer}[/{taxon}], /{net}/nft/{ID}; Holders tab + account NFTs tab (not on boards);
  node fallback uses Clio nft_info (XRPL) -> E7 sandbox XRPL Testnet node should be Clio; search 64-hex: tx, ledger, NFT, then node;
  checkCoverage + CoverageNote NEW & SHARED (E10, E11, E14 reuse); only NFT page OG card; recent sales 10 rows.
- Terms: NFT (avoid collectible), NFToken, URIToken, Collection (avoid series), Taxon, Serial, NFT owner (avoid holder for one NFT),
  Collection holders, Sale (direct/brokered), Transfer, Royalty (avoid creator fee), Open offer, Coverage.
- Reprocess: XRPL from 75443457, Xahau from first ledger (or one shared reprocess from 32570).

## F Validators map (D8 433 lines; E13 415 lines) — DONE
- D8: uses D4's domain_tomls store (readToml, cleanTomlText, countsOn, recordToml, nextTomlRow, DomainTomlsService); facts only from verified toml;
  ISO alpha-2 + XK, UK->GB; /v2/network/validators/countries (for API clients; explorer counts from list); list `country` filter (code|unknown);
  principals names only (drop any with @); validators checker writes into D4 store; toml_version re-check; network/unl served as claims;
  `toml` last key of row ({} when none); countries default scope unl; ADR-0012 amendment.
- E13: map counted from the list call (no countries call); circles + names are links (?country=); map one Tab stop w/ arrows; area ∝ count;
  map always All; Unknown location link; attribution toml only; every ISO country has a point; toml card only for verified domain;
  dots static SVG asset via <use>; deps: D8, E6, E9 (AccountLink), E11 (tokenLink, TOKENS), E7.
- Terms: Server country (avoid location/geolocation), Owner country (avoid nationality), Unknown location (avoid unlocated), Toml store (DAPI), Toml, Principal (DAPI).

## B Names (D4 537 lines; E9 385 lines) — DONE
- D4: new syncer worker `tomls` (egress to tens of thousands of hosts; GH_DOMAIN_VERIFICATION=false disables); strict Domain (printable ASCII, lower, rippled check; URL/IPFS = none);
  [[ACCOUNTS]] counts when network absent or this network; verified name = desc if ≤64 chars else domain; network name alone = kind account;
  re-check schedule (24h ok / 1h transient, names kept 24h / 1,2,4,7 d definite); new table account_domains one row per account (ADR-0007 exception), one-off SQL seed from account_states;
  no coverage field; store never keeps emails, [[SERVERS]], [ORGANIZATION]; second route GET /v2/toml/{domain}; duplicates answered twice, X-addresses 400;
  batch `labels` vs /v2/accounts `account_labels`; one new ADR amending ADR-0014; before first toml load no display name; account_domains read failure -> 500.
- E9: failed names call -> addresses, page not stored; immutable pages w/ names kept 1h at edge; account page two names calls; ≤400 named addresses/page;
  link text "name · network name"; hover "Verified by {domain}"; only account's own meta/OG use names; "How we know" closed; only verified domain linked;
  toml facts only verified; "ask GateHub" link needs owner URL; label banner/mark designed here; NAMES off until D4 seed + first sweep.
- Terms: Account domain (avoid domain field), Toml store (avoid toml cache), Name mark (avoid badge), Label mark (avoid flag).
- Interfaces for others: readStoredTomls, DomainTomlsService.get, cleanTomlText, recordToml (D8 writes validator tomls); D-env's tomlNetworkNames.
- CORRECTIONS for consistency pass: D8 assumed store version column `fetched_at` -> it's `checked_at`. D6 told (msg) no own fetch source.

## D Tokens (D6 641 lines; E11 448 lines) — DONE (may get a follow-up revision re: no own toml fetch source)
- D6: token = (currency, issuer) where other side holds/trusts; holders = positive balances; trust lines incl zero w/ limit; supply = Σ holders;
  LP tokens excluded; new ledger table `state_touches` + TOKEN_PARSER_VERSION; generations swapped whole (needs DROP PARTITION for syncer user);
  price/volume live from markets_live; ranked by holders (marker moves with ranking); totals fixed 10-holder threshold; toml listing checked both ways;
  no node fallback; transfers from payments_by_currency; shares 6 dp; charts deferred; new ADR; coverage from network's first ledger (no amendment; adds case to D3 FeatureCoverageService).
- E11: charts and "+N in 90 days" dropped; "Supply" not "Circulating"; toml card from token answer, icon link only; Markets card; AMM top 5;
  price fallback to last trade ≤30 d; list tiles network-wide; 20 rows/page, search via API; holders sub-page; transfers page w/ markers;
  404 with coverage note; LP-token URLs redirect to pool; MPT tab disabled; links from account/pair/pool/search; preview image; CoverageNote.
- Terms: Issued token (DAPI; avoid IOU), Holder (avoid owner), Supply (avoid circulating, outstanding), Transfer, Listed in the issuer's toml (avoid verified token),
  Token generation (internal), State touch (internal; avoid dirty mark).
- Rollout: migration -> syncer -> API; TOKENS on when syncer_tokens_live = 1. Deps: #20 trust_line_states, account_states, STATE_PARSER_VERSION; D3 coverage; D4 currencies; D2/D2b markets; E9; E12 menu.
- NOTE: "Supply" term conflicts with explorer glossary "Total supply"/"Circulating supply" (native currency). Token supply vs native supply — reconcile in glossary (token's "supply" ok, scoped to tokens).

## C Ledger objects + delegation (D5 590 lines; E10 432 lines) — DONE
- Found: delegated tx fee row in balance_changes goes to Account, but delegate pays -> D5 fixes (fee row moves to delegate).
- D5: one object_changes table (check_events folded in); state at query time; only aggregate `escrows` (for D7, readEscrowed); owner+sequence via
  /v2/accounts/{a}/escrows/{sequence}; time-derived `status`; detail embeds newest 50 events, older via /history; channel past CancelAfter/Expiration = closing;
  no node fallback in API; delegate gets account_transactions row, CSV gains `delegate`, fee to payer; Xahau delegations empty list complete:true;
  /delegations?direction= (not /delegates?role=); GET /v2/ledger_objects/{id} for search; re-ingest from 107,524,865 at deploy; OBJECT_PARSER_VERSION;
  Xahau amendments file gains genesis ledgers; IOU channel typing fixed in balance_changes.
- E10: plural routes + owner/sequence redirect; "All escrows" dropped; states strip static legend (OWNER: keep or drop); "As of ledger #N";
  "Sent by" regardless of DELEGATION switch; wording "sent it on behalf of"; Delegation tab no count ≤200 rows; 50 events Newer/Older; no OG image;
  owner reserve = current reserve; Objects tab gets From + Delegate rows; expired channel = Closing; Pill gets warn tone. Uses E9 collectAddresses/loadNames, E7 hasDelegation.
- Terms: Ledger object ID (avoid index, hash), Removed (avoid deleted, closed), Fee payer; Escrow & Payment channel "native currency or a token" in both;
  DAPI glossary lacks Escrow, Check, Payment channel, Delegation, Delegate, Permission -> copy from explorer.

## H Environments (D-env 496 lines; E7 508 lines) — DONE
- Facts checked 2026-10-24: XRPL Testnet net id 1, Xahau Testnet 21338; clio.altnet.rippletest.net:51234 is Clio (full testnet history, nft_info) but drops conns after quick requests;
  s1/s2.ripple.com are Clio; s.altnet.rippletest.net and xrplcluster.com answer unknownCmd to nft_info.
- D-env: GH_NETWORK += xrpl-testnet, xahau-testnet; DBs xrpl_testnet, xahau_testnet; sandbox own stack + ClickHouse; sandbox starts at current ledger (no backfill);
  Xahau Testnet: GH_UNL_VALIDATORS fixed list (publisher `local`); testnets reuse mainnet amendments file, ignore enable ledgers; 15 retired XRPL amendments get `retired`;
  testnet markets empty; public testnet nodes default; xahau profile refuses 21338 node; testnet reset halts syncer, runbook drops DB; GH_UNL_PUBLISHERS=default;
  majority hold testnets 14d/5d (to verify); exports off in sandbox.
- E7: Worker var ENVIRONMENT; sandbox X-Robots-Tag noindex; existing switches off in sandbox; badge w/o tooltip; amounts XRP/XAH; no USD view on testnets;
  mainnet CTIDs not linked to production; staging checklist split sandbox/production/build; Clio XRPL node everywhere, no nft_info on Xahau; sandbox deploys by hand;
  home line + OG pill "XRPL Testnet"; `local` shown "Fixed list"; redeploy new build id after reset; a test keeps "staging" out of code.
- Terms: update DAPI Network & Environment (say sandbox runs mainnets today); Testnet (avoid altnet); Network profile; Fixed list (avoid static/local UNL); Network family.
- Deps: E7 needs D-env deployed; E8 Clio both envs; D3–D9 enable ledgers from amendments data (never constants) -> testnets coverage complete:false;
  D8 compares toml network to profile kind; #20 per-network account names lost on testnet reset.
- D6 REVISED (653 lines): tomls only through D4 (accountDomainOf, readStoredTomls, countsOn, cleanTomlText), no own fetch; coverage right after `result`, counts total/total_below; supply = issuer's obligations.

## G MPT (D9 632 lines revised in place; E14 466 lines) — DONE
- D9: routes /v2/mpt/{id}, /holders, /transfers; list = D6 /v2/tokens?kind=mpt; mpt_daily + /stats dropped; mpt_holders_by_amount dropped; MPT payment volume dropped;
  MPT balance change = 2 rows (holder + issuer mirror); new batch GET /v2/mpt?ids= (≤100: ticker, name, scale); escrowed_amount = LockedAmount, locked_amount = issuer lock;
  change_type clawback for every Clawback (issued too); XLS-89 lenient decode w/ metadata_conforms; transfer kinds payment/clawback/lock/unlock/3 escrow kinds;
  amounts in integer units; exchanges/AMM/path payments still skip MPT; issuance outside coverage 404 until reprocess; account holdings at newest indexed ledger only;
  new issuance 404 until next tick; Xahau MPT routes complete:true; MPT_PARSER_VERSION.
- E14: no holders chart; Locked tile = issuer lock; flags wording DynamicMPT + inactive DEX; separate holders/transfers pages; one ?ids= call per page;
  MPT holdings on Tokens card from node; node fallback when index lacks issuance; metadata links https only; 48-hex search -> MPT page; Xahau 404 with board text;
  mpt OG image; Clawback sentence for issued tokens too; server-side q; MPT on before coverage complete. Needs E11 mptAvailable seam, E9 loadNames, D6 envelope, TOKENS on.
- Terms: Issuance ID (avoid MPT ID, currency), Asset scale (avoid decimals, precision), Escrowed amount (avoid locked amount), Locked balance (avoid frozen), Outstanding amount (avoid supply).
- Reprocess ~8.5M ledgers from 99226369. One reprocess after the program's last parser version.
- CONFLICT: D5 depends on D9's MPT amount representation; E10 waits for E14's MptAmount — but D5/E10 are built BEFORE D9/E14. Fix in consistency pass:
  define the MPT amount shape in D5 (+ minimal MptAmount in E10); D9/E14 extend.

## E Supply (D7 551 lines; E12 420 lines) — DONE
- D7: hourly snapshot at one ledger, newest served; XRPL burned = 100B − total_coins exact, Xahau burned = Σ indexed fees; reserves = what accounts must keep (AMM accounts excluded);
  escrowed native only (paychan XRP = circulating); minted sources rewards (GenesisMint whose parent is ClaimReward), other GenesisMint, Import;
  minted per day new cheap route; burned per day reuses /v2/network/fees?interval=day; reward_claims ordered by ledger, imports subset (differs from family-5 spec);
  404 "supply not computed yet"; reserve values from network_state, fallback newest SetFee; per-part coverage (D3 shape). Xahau full reprocess for 3 new mint tables (needs a gate constant).
- E12: title "Supply", no tabs; no escrow releases / escrows link; burned chart source fees route; 90 d = today + 89; circulating segment series colour 1;
  no label on Xahau 3% escrowed; bar no table view; minted tile 90 d + since line; Network menu = disclosure (not ARIA menu), no Nodes;
  Validators + Amendments get header links for the first time; SUPPLY on only when escrowed coverage complete; warning if snapshot > 3 h old; cached slow 300 s; budget 150 KB.
- Terms: Minted (avoid inflation, issuance), Account reserves (avoid locked), Reward (avoid staking reward, interest), Supply snapshot.
- Deps: D3 coverage (+ no-amendment case), D5 readEscrowed (escrows job writes sentinel watermark each run; firstLedger), #20 account_states, D1 network_state, AMM amm_pools/fillForward, E8 coverage; E8 + E11 add NFTs/Tokens header items before E12's menu.

# ALL 8 SPEC PAIRS DRAFTED. Next: cross-spec consistency pass (agent), glossaries, overview constraints, commit, user review.

# SPECS APPROVED by owner (2026-10-24) with all recommended decisions. Commits: EXP f01d2fc, DAPI 75ad3c5.
Execution method: subagent-driven, auto mode (as program 1). Bundle: ruling R19 stands (lookup 150 KB, dashboards 160 KB; supply = dashboard).
# PLAN PHASE: 8 plan writers dispatched (brief PLAN-BRIEF.md). Plan files:
- env: DAPI plans/2026-10-24-testnet-profiles.md, EXP plans/2026-10-24-sandbox-environment.md
- NFTs: DAPI plans/2026-10-17-nft-data.md (replaced), EXP plans/2026-10-24-nft-pages.md
- names: DAPI plans/2026-10-24-display-names.md, EXP plans/2026-10-24-display-names.md
- objects: DAPI plans/2026-10-24-ledger-objects-delegation.md, EXP plans/2026-10-24-ledger-object-pages.md
- tokens: DAPI plans/2026-10-24-issued-tokens.md, EXP plans/2026-10-24-token-pages.md
- supply: DAPI plans/2026-10-24-supply.md, EXP plans/2026-10-24-supply-page.md
- validators: DAPI plans/2026-10-24-validator-toml-details.md, EXP plans/2026-10-24-validators-map.md
- MPT: DAPI plans/2026-10-17-mpt-data.md (replaced), EXP plans/2026-10-24-mpt-page.md
Numbering: migrations D3 011, D4 012, D5 013, D6 014, D7 015, D8 016?, D9 next; gates NFT 5, DOMAIN 6, OBJECT 7, TOKEN 8, MINT 9, MPT 10; ADRs next free from 0016.
Execution: two tracks in parallel (DAPI: D-env→D3→…→D9; EXP: E7→E8→…→E14, En after Dn; En task 1 = api:sync from DAPI worktree).
OWNER (2026-10-24): plans pre-approved — after plans are created, approve automatically and start implementing everything. Still ask before push/merge/deploy.
## PLAN supply DONE: D7 11 tasks/512 lines; E12 9 tasks/439 lines
- D7 rulings: recordings xahau/mint/; record-fixtures --below; NEW profile flags hasAmm, hasMinting (check vs D-env plan!); shared job tests packages/shared/test; minted gap days = 0;
  counter syncer_parser_anomalies_total; each job run ≥1 step; first account range starts at r; feature names fees, amm, account_states, mints.
- E12 rulings: paths straight into PATHS; formatDateTime; two-decimal compact; NavPage in app/ui/route-handle.ts + navPageOf; Header NavMenuItem/NavItem union; StatGrid wide prop.
- Interfaces: D7 supply-object.ts SUPPLY_KEYS, MINTED_BODY_KEYS, MINTED_ROW_KEYS; E12 NavPage/navPageOf/NavItem.
## PLAN tokens DONE: D6 13 tasks/624 lines (migration 014, parser 8, ADR-0019, ADR-0010 Amendment 8); E11 14 tasks/500 lines
- D6 rulings: parser marks AccountSet sender as changed (first-time Domain/TransferRate not in PreviousFields); coverage via FeatureCoverageService.coverage({parserVersion, amendment?});
  first build duration estimated synthetically.
- E11: D6 routes into PATHS; token() returns whole answer; not-found coverage note plain text; Xahau clawback bit 0x1000 in account flag table.
- Interfaces: D9 -> apps/api/src/tokens/token-list.ts TOKEN_KINDS=['issued'], TokenListService{kind; coverage(); list(q)}, TOKEN_LIST_SERVICES, tokenListBody, encode/decodeTokenListMarker (kind in marker); tokens.module.ts map.
  E13 -> tokenLink(net, asset, features), parseTokenPath(network, text) in app/domain/token-params.ts (Worker-only: call from view builder).
  E14 -> mptAvailableOf (false until E14), kindTabs, parseTokensParams(search,{mptAvailable}), tokensPage, TokensPage, DataApi.tokens kind "issued".
  E12 -> Tokens header item + "tokens" nav section.
- CHECK in consistency pass: ADR numbering (D6 says 0019 — implies 0016–0018 taken by D3/D4/D5?).
## PLAN validators DONE: D8 10 tasks/444 lines (migration 016_validator_toml_details.sql ALTER validator_domains; no parser version, no new ADR; ADR-0012 amended; ADR-0010 amendment expected #10); E13 11 tasks/449 lines
- D8 aligned with D4 plan names: readToml(text, profile, fetchedAt), recordToml, readStoredTomls, nextTomlRow/TomlCheck, tomlUrlOf, SyncerConfig.tomlRecheckMs, DomainTomlsService.get, NamesModule, TOML_VALIDATOR_KEYS in toml-object.ts.
- E13 carries land/water outlines + 55 board points in plan (no scratchpad dependency; port checked = 2,374 dots, 32,104 chars).
- Interfaces: D8 ISO_COUNTRY_CODES (packages/shared/src/validators/country.ts) == E13 COUNTRY_POINTS (250 codes).
## PLAN names DONE: D4 14 tasks/606 lines (migration 012_display_names.sql, DOMAIN_PARSER_VERSION 6, ADR-0017, ADR-0010 Amendment 6); E9 14 tasks/472 lines
- D4: readToml(text, profile, fetchedAt) required 3rd arg; worker batch-inserts ok rows via okTomlRow; recordToml (one row) is D8's path; Cc/Cf removed then whitespace collapsed;
  first discovery after restart marks nothing new; fixture scan ≤5,000 ledgers/network.
- E9: paths into PATHS; fixtures own task (T4); network page no names; ≤500 seeded addresses/network; NamesPart in app/domain/names.ts; marker pages brief header; AMM voter keeps "votes for…".
- Interfaces: packages/shared/src/tomls/ (cleanTomlText, accountDomainOf, countsOn, readToml, TomlInvalidError, tomlUrlOf, okTomlRow, recordToml, readStoredTomls, STORED_TOMLS_SQL);
  apps/syncer/src/tomls/toml-row.ts (nextTomlRow, TomlCheck); SyncerConfig.tomlRecheckMs; apps/api/src/names/ NamesModule exports DomainTomlsService.get, DisplayNamesService.of;
  E9 app/server/names-load.ts (collectAddresses, loadNames, NamesResult), app/domain/names.ts (NamesPart, plainNameOf, mergeNamesPart, shownIssuer), app/ui/names.tsx (NamesProvider), AccountLink props unchanged.
## PLAN env DONE: D-env 11 tasks/763 lines (no migration/parser/ADR number; amends ADR-0009, ADR-0012, ADR-0010 item 44 in place); E7 11 tasks/696 lines (no api sync)
- Rulings: explorer validators shape check accepts `local` publisher's empty url/public_key; data API e2e checks getTxCtid from parse context; reset tests in live-runner.e2e-spec.ts;
  threshold msg "the number of lists (<n>)"; domain checker also checks fixed list's validators' domains; explorer clientLoaders use isNetworkId.
- Interfaces DAPI network-profile.ts: NETWORK_NAMES, isNetworkName, networkChoiceText, networkLogText, NetworkProfile.family/kind/displayName/acceptedNodeNetworkIds/defaultUnlValidators;
  LOCAL_PUBLISHER_ID, parseUnlValidators, unlValidatorsOf, unlListCount, firstCommittedLedger; seeds xrpl-testnet-recorded, xahau-testnet-recorded.
  NOT here: firstLedger (D3), tomlNetworkNames (D4), hasDelegation (D5), hasMpt (D9) — each sub-project adds values to the 4 profiles. (D7 adds hasAmm, hasMinting.)
- EXP: app/ui/environment.ts (environmentOf, networkKindOf), useEnvironment, Network.kind/label/longName/dexName/displays, NETWORKS[kind][id] (E10 adds hasDelegation, E14 hasMpt),
  findNetwork(segment, kind), networkChoices, worker-sandbox project *-sandbox.spec.ts, sandbox block wrangler.jsonc, publisherLabel.
- CHECK: E10 plan adds hasDelegation; E14 adds hasMpt (explorer). D5 adds hasDelegation, D9 hasMpt (DAPI).
## PLAN MPT DONE: D9 15 tasks/567 lines (017_mpt.sql, MPT_PARSER_VERSION 10, ADR-0020); E14 15 tasks/543 lines
- D9: util/mpt.ts (from D5) gains ID fns; conservation rule per tx+issuance Σ(ΔMPTAmount+ΔLockedAmount)=ΔOutstandingAmount; Clawback fee row stays transaction_cost;
  route param issuanceId; coverage COVERAGE_FEATURES entry `mpt`; list via D6 TOKEN_KINDS/TOKEN_LIST_SERVICES.
- E14: MPT tab behind marker = minute; asset_scale 0–255 accepted (>19 unscaled); mpt segment carries issuer; paths into PATHS.
- E14 relies on D9: openapi at D9 T14 (/v2/mpt, /v2/mpt/{issuanceId}, /holders, /transfers, /v2/accounts/{address}/mpt, kind issued|mpt), fixtures xrpl/mpt/manifest.json, apps/api/src/mpt/mpt-objects.ts.
EXECUTION STARTED (2026-10-25): plans D-env (8a0f648) & E7 (6ed915b) committed; workspaces .superpowers/sdd/<plan>/progress.md; pnpm install done both; baseline running; preflight scans dispatched.
## PLAN objects DONE: D5 14 tasks/714 lines (013, OBJECT_PARSER_VERSION 7, ADR-0018, ADR-0010 Amendment 7); E10 15 tasks/704 lines
- D5: Xahau escrows/channels/checks no amendment -> firstLedger (Xahau Escrow/PayChan retired; xahau.json unchanged); readEscrowed undefined before first run; sentinel after every step.
- E10: issued-token values via isNumberText; paths into PATHS; object recordings NOT added to SETS.
- FIX NEEDED (plan consistency): D6 plan calls FeatureCoverageService.coverage(descriptor) — D3's real API takes a name: register in COVERAGE_FEATURES (apps/api/src/common/coverage-features.ts) or coverageOf(key, feature). D5 registers escrows, payment_channels, checks, delegations.
- Interfaces: D7 readEscrowed(ch): Promise<Escrowed|undefined> in packages/shared/src/aggregate/escrows.job.ts; coverage('escrows'); tick order amm_pools, nft_state, escrows, …
  D9 packages/shared/src/util/mpt.ts MptAmountObject, mptAmountObject, mptIssuerOf, isMptIssuanceId.
  E14 MptAmount {id, units, href?} app/ui/components/MptAmount.tsx; DisplayAmount {mpt:{id,units}}; escrowPage(source,o) in app/server/ledger-object-view.ts / escrow-view.ts.
  E11/E13/E14: objectRows(objects, ctx: ObjectRowsContext); Segment += object, permission; rowSentence(description, viewer?); findHash(api,node,hash,{nfts, ledgerObjects}); Network.hasDelegation beside hasAmm.
## PLAN NFTs DONE: D3 15 tasks/874 lines (18 rulings); E8 16 tasks/689 lines (10 rulings)
- Xahau first ledger = 1 (URIToken enabled at 1; reprocess --from 1). Coverage = named registry COVERAGE_FEATURES {parserVersion, startOf(profile)}; FeatureCoverageService.coverage(name), coverageOf, itemCoverage, isAvailable; Coverage, COVERAGE_KEYS; parser-coverage.ts newestLedgerBelowVersion, coverageFrom; NetworkProfile.firstLedger. D3 T13 readNewestPage (newest-page.ts).
- E8: app/server/coverage.ts checkCoverage(body, path?), coverageNote(coverage, words, subject?); CoverageNote.tsx; resolve.ts findHash(api,node,hash,{net,nfts}); app/domain/nft-link.ts nftLink.
- ALL 16 PLANS WRITTEN. Plan consistency pass dispatched (14 plans; D-env/E7 frozen, executing).
EXEC: E7 Task 1 dispatched (BASE 6ed915b). D-env waiting on preflight scan.
EXEC: D-env Task 1 dispatched (BASE 8a0f648). Shared dispatch texts: specs-kit/IMPLEMENTER.md, specs-kit/REVIEWER.md (task review + re-review mode).
Per-plan workspace files: .superpowers/sdd/<plan>/{progress.md, global-constraints.md, task-N-brief.md, task-N-report.md, review-*.diff}
Scripts dir: "/Users/golobitch/Library/Application Support/Claude/local-agent-mode-sessions/0ed8c108-8b2a-4845-88c5-ee89977cd684/49390995-b6a1-478f-ad4c-04cfbe476eaf/rpm/plugin_01JETPTMWTgidsotmEhVkQTG/skills/subagent-driven-development/scripts" (run with cwd in the worktree).
PLANS COMMITTED (auto-approved per owner): DAPI 5e498c2 (D3–D9), EXP de3d12c (E8–E14); D-env 8a0f648, E7 6ed915b. pnpm lint removed (no ESLint config in data-api).
Unresolved notes from plan pass: E14 adds xrpl-mpt to SETS w/o moving head (E14 Step 4 check catches); D4 mentions D6 calls DisplayNamesService.of (harmless).
EXEC helper: specs-kit/sdd.sh (ws|brief|review|log <dapi|exp> <slug>)
E7 COMPLETE 2026-10-25: commits 6ed915b..49634e6 (11 tasks + final fix wave), final review Ready to merge. Next explorer: E8 after D3.
D-env ALL 11 TASKS COMPLETE (8a0f648..f59102e); final review (opus) running. D3 workspace created (BASE f59102e); preflight scan running.
D3 preflight: 59 rows, 11 conflicts ruled (C1–C11). Waiting for D-env fix wave before D3 Task 1.
D-env COMPLETE 2026-10-25: 8a0f648..5294876 (11 tasks + final fix wave; final review With fixes -> fixed & re-reviewed). Owner inputs: XRPL Testnet hold 1800 s inferred (ask Ripple), Xahau Testnet 5 d software default; sandbox GH_CORS_ORIGINS empty + 6000 rate budget.
