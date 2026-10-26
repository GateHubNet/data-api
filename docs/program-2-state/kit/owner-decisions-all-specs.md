# Program 2: owner decisions to confirm

Every spec opens with a table of the choices its drafter made that you didn't, and its deviations from the mock, each with a
recommendation. Here are all sixteen tables, by feature, in build order. Approving the specs accepts the recommendations;
to change one, name the feature and row.

Specs: data API `data-api-worktrees/explorer-data-2/docs/superpowers/specs/`, explorer `x-explorer-worktrees/explorer-pages-2/docs/superpowers/specs/`
(overview: `2026-10-24-explorer-program-2-overview.md`).

## 1. Environments: sandbox on testnets

### Data API — `2026-10-24-testnet-profiles-design.md` (14 rows)

| # | Choice | Recommendation and why |
|---|---|---|
| 1 | A testnet is a network of its own: `GH_NETWORK` takes `xrpl-testnet` and `xahau-testnet`, one complete profile each (section 2). | Recommended over a second variable (`GH_NETWORK=xrpl` + `GH_TESTNET=true`): every fact that differs (node ids, endpoints, lists, files, database) is then in one record, and forgetting a variable cannot run a testnet with mainnet's database and lists. |
| 2 | Testnet databases are `xrpl_testnet` and `xahau_testnet` by default (section 9). | A testnet process pointed at a mainnet ClickHouse by mistake writes beside the mainnet data, never into it. |
| 3 | The sandbox is its own stack on its own host and ClickHouse server, from the same compose file with `deploy/.env.sandbox` (section 10). Never a testnet api or syncer on the production ClickHouse. | The fixed container names already allow one stack per host; and the shared database (names, labels) has one name on every server, so a shared server would show a testnet's names on mainnet. |
| 4 | The sandbox indexes from its first boot (the validated head); no backfill of testnet history (section 12). | The rippled testnet nodes hold under a year (XRPL Testnet) and a few days (Xahau Testnet); the one full-history source, Ripple's testnet Clio (from ledger 209), throttles bursts, so a backfill through it would take months. Every list there shows its coverage notice, which is the truth. A backfill can come later through `range-ingest` against it or a GateHub node. |
| 5 | XRPL Testnet's list publisher is `https://vl.altnet.rippletest.net`. Xahau Testnet has **no publisher**: its nodes trust a fixed `[validators]` list of four keys. A new syncer setting `GH_UNL_VALIDATORS` holds such a list, stored as the list of the publisher `local` (section 5). | Without it no Xahau Testnet validator is trusted, and the amendment tallies and the validators pages of the sandbox say nothing. Alternative: no trusted set on Xahau Testnet (no new setting). |
| 6 | Testnets read their family's amendment metadata file (`config/amendments/xrpl.json`, `xahau.json`) and ignore its `enabled` entries, which are mainnet's ledgers and dates (section 6). | One file of names and descriptions per protocol; enablement on a testnet comes from its own ledger. |
| 7 | `retired` becomes valid on XRPL entries, and the 15 amendments rippled lists with `XRPL_RETIRE` are marked (section 6). | XRPL Testnet's ledger does not list them (they were retired before its genesis), so without the mark they would read "voting" there. On mainnet nothing changes: they are in the ledger. |
| 8 | Testnets ship an empty markets config (section 8). | No testnet token is a market anyone relies on; the volume series of the sandbox are empty, not wrong. |
| 9 | The default node endpoints of the testnets are the public servers (`wss://s.altnet.rippletest.net:51233`, `wss://testnet.xrpl-labs.com`; `wss://xahau-test.net`); GateHub sets its own in `deploy/.env.sandbox`. | As for mainnet: a working default, overridden per deployment. |
| 10 | The `xahau` profile stops accepting a node that reports `network_id` 21338 (section 4). | Today `GH_NETWORK=xahau` silently ingests Xahau Testnet; each network now accepts exactly its own id. |
| 11 | A testnet reset halts the syncer (`ChainBreakError`), and the runbook drops and recreates that network's database (section 11). | Ledger indexes repeat with other hashes after a reset; nothing can be kept. |
| 12 | `GH_UNL_PUBLISHERS=default` (and `GH_UNL_VALIDATORS=default`) means "the network's default", so compose no longer spells out mainnet's publishers (section 10). | The compose default text is XRPL mainnet's, which would make an XRPL Testnet syncer trust mainnet's list. |
| 13 | Amendment majority hold on the testnets: 14 days (XRPL Testnet) and 5 days (Xahau Testnet), as on mainnet, **to verify** before the profiles ship (section 1). | Neither network publishes the value; the plan records how it was checked. |
| 14 | Exports are off in the sandbox unless it is given a bucket of its own. | A testnet export is for testing the feature only. |

### Explorer — `2026-10-24-sandbox-environment-design.md` (15 rows)

| # | Choice | Recommendation and why |
|---|---|---|
| 1 | One Worker variable, `ENVIRONMENT`: `"development"` (top level), `"sandbox"`, `"production"`. The sandbox shows testnets, the other two mainnets (section 5). | The facts of a network (names, CTID id, USD display) follow from it, in one table. The top level shows mainnets because every fixture is mainnet data. |
| 2 | The sandbox answers every response with `X-Robots-Tag: noindex`; `robots.txt` stays the same in both environments (section 8). | Test-network pages out of search results, while link previews (whose crawlers read `robots.txt`) still unfurl for the people testing. |
| 3 | The five program-1 switches start "off" in the sandbox, and go on by their own conditions, measured on the sandbox's data API (section 9). Every program-2 switch is added "off" there. | As for production; the sandbox's data API starts empty. |
| 4 | The badge as on the board, without the board's `title` tooltip ("Sandbox: explorer.sandbox.gatehub.net"). | A tooltip is not reachable by keyboard or touch, and the word already says it. |
| 5 | Amounts keep their codes: XRP and XAH, not "test XRP". | The badge and the network names say "Testnet" on every page; the ledger's own currency code is XRP. |
| 6 | No USD view on the testnets: `?in=usd` on `/{net}/network` redirects to the view without it (section 7.5). | Its USD is GateHub's mainnet issuer; the testnets have no such market. |
| 7 | A mainnet CTID searched in the sandbox gets today's sentence, "… is for network id 0, which this explorer does not cover.", with no link to production (section 7.7). | No URL of the other environment in the code. |
| 8 | The "Staging checklist" splits into a **sandbox checklist** (the environment: hosts, caches, holds, switch flips) and **production checks** (what needs mainnet data), plus **build figures** (section 14). The end-to-end suite is no longer run against a deployed sandbox. | The fixtures and most checks name mainnet accounts, pools and pairs, which the sandbox's testnets do not have. |
| 9 | The sandbox's XRPL node is Ripple's testnet Clio, `https://clio.altnet.rippletest.net:51234/`; production keeps `https://s1.ripple.com:51234/`, also a Clio. The XRPL node of every deployed environment must be a Clio (section 4). | E8's NFT pages fall back to Clio's `nft_info`; a rippled answers it `unknownCmd`. No Clio serves Xahau, so that fallback does not exist on either Xahau network. |
| 10 | Sandbox deploys stay by hand (`pnpm deploy:sandbox`); the release workflow deploys production only, as today. | No change to the release pipeline in this sub-project. |
| 11 | The home page's status line and the link preview's pill say "XRPL mainnet" in production and "XRPL Testnet" in the sandbox (section 7.3). | The board's pill; "XRPL Testnet mainnet" would be wrong. |
| 12 | Xahau Testnet's fixed validator list (D-env's publisher `local`) reads "Fixed list" (section 7.6). | The data API's id `local` means nothing to a visitor. |
| 13 | After a testnet reset, the sandbox is deployed again with a new build id (section 11). | Its edge and subrequest caches hold ledgers of the old chain for up to a year. |
| 14 | A unit test keeps the word "staging" out of the code, the scripts, the tests and the README (section 2). | The rename is complete only if it stays complete. |
| 15 | **Consistency pass:** in the sandbox, a program-2 switch whose condition asks for complete coverage (E10's `DELEGATION`, E12's `SUPPLY`) goes on once the sandbox's data API serves the feature, with its coverage notes (section 9). | The testnets' coverage is never complete (D-env §12), so the condition could never hold there. |

## 2. NFTs

### Data API — `2026-10-17-nft-data-design.md` (20 rows)

| # | Choice | Why / recommendation |
|---|---|---|
| 1 | **Changed:** a new parser version with its own gate constant `NFT_PARSER_VERSION`; the tables come in the next migration, not in the baseline. | Version 3 and migrations 005–010 are PR #20's, and the baseline is deployed. The plan assigns the numbers. |
| 2 | **New:** every list and aggregate answer carries `coverage {from_ledger_index, complete}`; the NFT detail, history and offers carry the NFT's own (complete when its mint is indexed) (section 4). | The brief's shape. Per NFT, a token minted after the coverage start has its whole life in the index. |
| 3 | **Changed:** `nft_daily` and its job are dropped. `/nft_collections/{c}/stats` is a query-time aggregate over the collection's events, at most 366 days (section 5.10). | The brief defers history charts that need a new daily statistics job; one collection's 30 days is a cheap prefix read. |
| 4 | **Kept, narrowed:** `nft_volume` is a metric of the existing volume jobs, with the live periods `day`, `7day` and `30day` only (the board's), one component per collection, in the native currency. | No new job; the board's chart and tiles read it. Three live sets, not five. |
| 5 | **New:** a narrow ledger table `nft_touches` (ledger order) feeds the aggregator, as `amm_pool_touches` does. | The jobs need "which NFTs changed in these ledgers" without scanning the wide tables. |
| 6 | **Changed:** `account_nfts` holds one row per (owner, NFT) with `held`, rewritten per NFT, not one version set per owner. | A 120k-NFT owner no longer rewrites 120k rows when one NFT moves. |
| 7 | **Changed:** the NFT detail is folded at read time from the NFT's own events, not read from the `nfts` table. | Fresh at commit time like the AMM history; `nfts` serves the collection and holdings lists only. |
| 8 | **New:** `nft_collection_holders` and `GET /v2/nft_collections/{c}/holders`. | The brief asks for a collection Holders tab (the board has a Holders count only). Recommend: build it; it is written by the collections job at no extra read. |
| 9 | Collection routes: XRPL takes `{issuer}/{taxon}`, Xahau `{issuer}`; the other form answers 404 `collection not found`. Literal sub-routes are registered before the taxon form. | One key per network; a taxon is digits, so `nfts`, `holders`, `sales` and `stats` can never be read as one. |
| 10 | **Changed:** `/v2/nft_collections` gains `descending` and `total` (the collections the filter matches); sort `volume`, `supply`, `holders`. | The board sorts both ways and says "of 38,511 collections". |
| 11 | **Changed:** `/v2/nft_sales` filters by `currency=CUR[+issuer]` (the payments form), not `currency` + `issuer`. | `issuer` means the NFT's issuer everywhere else in these objects. |
| 12 | **Corrected:** the royalty estimate of a brokered sale is the fee on the price less the broker fee (rippled `NFTokenAcceptOffer::acceptOffer`); none when the issuer is the seller or the buyer. | The 2026-10-17 text took it on the whole price. |
| 13 | **Corrected:** a `URITokenBuy`'s price is the transaction's `Amount` (what the seller receives, xahaud `URIToken.cpp`), not the offer's. | The buyer may pay more than asked. |
| 14 | Prices stay in their own currency; `converted_amount` (native) is added where the asset has a daily native rate (`DailyRates`, D2's data). A sale without a rate counts in sales, not in volume. | "Conversion only if existing rate data supports it." |
| 15 | The node fallback for an NFT the index does not have belongs to the explorer; this API answers `nft not found` and reads no node. | As for transactions and AMM pools: the API serves the index. |
| 16 | `event` filters take a comma list; account roles are `issuer`, `minter`, `from`, `to`, `broker`, `offer_owner`, `destination`. | The board's "Show offer events" is one call; the roles name what the events record. |
| 17 | Coverage ignores gaps in the stored ledgers, as the state history's does. | Gaps are an operational fault with their own checks (`operations.md`). |
| 18 | Xahau's amendment metadata file gets `URIToken`'s enable ledger (the network's first ledger); without a known enable ledger `complete` is always false. | Xahau enabled URITokens at genesis, so no `EnableAmendment` exists to read. |
| 19 | A URIToken burned and minted again by the same issuer with the same URI is the same id (xahaud keys it on issuer and URI): its state follows the newest events. | New fact, found in xahaud's `URIToken.cpp`. |
| 20 | **New (consistency pass):** the coverage service is the program's one rule (section 4): a feature without an amendment starts at `NetworkProfile.firstLedger` (new: XRPL 32,570, Xahau genesis, none on the testnets), a feature the network cannot have is `complete: true`, enable ledgers come only from the amendments data (testnets: `complete: false` without an indexed `EnableAmendment`), and `coverage` is the key after `result` on every new endpoint. | D5, D6, D7 and D9 need these cases; D3 builds the service first, so it defines them once. |

### Explorer — `2026-10-24-nft-pages-design.md` (18 rows)

| # | Choice | Why / recommendation |
|---|---|---|
| 1 | Routes: `/{net}/nfts`, `/{net}/nfts/sales`, `/{net}/nfts/{issuer}/{taxon}` (XRPL) and `/{net}/nfts/{issuer}` (Xahau), `/{net}/nft/{ID}` (section 1). | One URL per collection key on each network; the collection sits under the list, as a pool under `/amm`. |
| 2 | "Older sales →" opens a sales page of its own; "More collections →" pages the table in place, and a page behind its marker shows the table only. | Two independent pagers cannot share one URL. |
| 3 | **Not on the board:** a Holders tab on the collection page (holder, NFTs held, share of supply). | The brief asks for sales, holders and tokens tabs; D3 serves holders cheaply. Recommend yes. |
| 4 | **Not on the Account board:** an NFTs tab on the account page (`?tab=nfts`, "URITokens" on Xahau), from the index; the Objects tab's NFT rows link to it and to the NFT pages (section 6). | An account's NFTs need a paged list; the Objects tab is the node's 400 objects, NFT pages of up to 32 NFTs each. Recommend yes. |
| 5 | The chart's measure switch (Volume, Sales, Average price, Lowest price) and the sort direction are links (`?measure=`, `?order=asc`). | One URL per view, works without JavaScript; the four measures are one cached call. |
| 6 | "Collections of an issuer" and "Held by an account" take one exact address (a GET form), not a substring. | The API filters by an exact address; filtering one page in the browser would hide the pages behind it. |
| 7 | Open offers come from the index for an indexed NFT (the board's source) and from the node only for an NFT shown from the network. | One source per mode; the coverage note says when the NFT's history starts after its mint. |
| 8 | The XRPL fallback reads Clio's `nft_info` (the configured `s1.ripple.com:51234` is Clio). Against a node without it, an NFT the index lacks is a 404. | rippled cannot look an NFT up by id. E7 (built first) makes the XRPL node a Clio in every deployed environment (E7 decision 9: Ripple's testnet Clio in the sandbox). |
| 9 | A 64-hex search asks the index for a transaction, a ledger and an NFT side by side, then the node; two or more found is the choice page. | An NFT id and a hash look alike; asking costs one more call only for unknown hashes. |
| 10 | Prices stay in their currency, with "≈ 96 XRP" under an issued-currency price when the API converts it; royalty in the native currency when the sale is converted, else in the price's currency. | The brief: conversion only where rate data exists (D2's daily rates via D3). |
| 11 | Coverage: one faint line under each list or figure whose `coverage.complete` is false ("Covers ledger #96,100,001 onwards…"), per NFT on the NFT page. | The brief's notice; one shared component (`CoverageNote`) later features reuse. |
| 12 | The history hides offer events unless "Show offer events" (`?offers=1`); the offers one transaction removed are one row ("2 offers removed by the sale"). | The board's default and its row. |
| 13 | A link-preview image for the NFT page only (kind `nft`); the list and collection pages have tags without an image. | As E5 (images of things, not lists); a collection's key does not fit the image route's one id. |
| 14 | Recent sales on the list are 10 rows (the board shows 8); Xahau keeps the board's Sale and Royalty columns ("direct", "—"). | A round page; the board's columns. |
| 15 | No page polls or refreshes itself. Classes: the list and a collection `minute`, an indexed NFT `live`, a burned one `slow`, one from the network `short` (60 s). | The data changes at the aggregator's minute; nothing on the boards is live. |
| 16 | The top collections read `/v2/network/nft_volume?live=…` (the API's parameter), not the board caption's `period=`. | D3 keeps the volume routes' contract. |
| 17 | `NFTS` goes on in an environment once D3 serves both networks there and its lag gauges are near 0, before the history is complete. | The coverage notes say what is missing; waiting for the full re-ingest would hold the pages back for days. |
| 18 | The account header's "URI token(s)" count becomes "URIToken(s)". | The glossary's word. |

## 3. Display names

### Data API — `2026-10-24-display-names-design.md` (14 rows)

| # | Decision | Recommendation |
|---|---|---|
| 1 | A sixth syncer worker, `tomls`, fetches the toml of every domain an account names (default `GH_WORKERS` gains it; `GH_DOMAIN_VERIFICATION=false` idles it). Outbound HTTPS grows from ~150 validator domains to every domain accounts name: tens of thousands of hosts. | Accept |
| 2 | A Domain names a domain only when its bytes are printable ASCII and, lower-cased, pass rippled's `isProperlyFormedTomlDomain`. `https://x.com`, a path, an IP, an IPFS hash name no domain and give no display name. | Accept (xrpl.org: "must match exactly") |
| 3 | An `[[ACCOUNTS]]` entry counts on a network when its `network` is absent or one of the network's names (XRPL `main`, `mainnet`; Xahau `main`, `mainnet`, `xahau`, `21337`; the testnets' from D-env). | Accept |
| 4 | The verified name is the entry's `desc` cleaned (`cleanTomlText`); a `desc` longer than 64 characters is not a name and the domain is used instead (nothing is cut). A `desc` can claim any name, so `domain` is always in the answer and the explorer shows it on hover. | Accept |
| 5 | An account network name without an account name is the display name (kind `account`); the settled order has no slot for it otherwise. | Accept |
| 6 | Re-checks: a toml read OK, after 24 h; a domain more accounts name than at its last check, at once (at most hourly); a transient failure (DNS, connect, TLS, timeout, 5xx, 429), after 1 h, the last good content kept 24 h; a definite failure, after 1, 2, 4, then 7 days. | Accept |
| 7 | Current domains come from a new ledger-derived table, `account_domains`, that keeps the newest row of each account (`ReplacingMergeTree(version)` ordered by account): a deliberate exception to ADR-0007's unique-key rule, safe because every deleted ledger is rewritten. A one-off SQL seed from `account_states` fills it for the ledgers PR #20's parsers wrote: no re-ingest. | Accept |
| 8 | Coverage: an account whose Domain was set before the state history starts and whose root has not changed since has no domain (so no verified name) until it changes or the history is complete (ADR-0015). The names answer carries no `coverage`. | Accept |
| 9 | The toml store keeps `[[ACCOUNTS]]`, `[[CURRENCIES]]`, `[[VALIDATORS]]`, `[[PRINCIPALS]]` names and `[METADATA]` `modified`/`expires`; never a principal's email or social handle, never `[[SERVERS]]` or `[ORGANIZATION]`; `expires` is kept, not acted on. Nothing in a toml is ever fetched. | Accept |
| 10 | A second new route, `GET /v2/toml/{domain}` (the boards' caption), serves what a domain's toml says as stored; the API never fetches on request. | Accept |
| 11 | The batch answers each requested address at its place: a repeated address is answered twice and counts towards the 100; an X-address is refused (400 `invalid ripple address`). | Accept |
| 12 | The batch's key is `labels` (the program's contract) where `/v2/accounts/{address}` says `account_labels`; the object is the same. | Accept |
| 13 | One new ADR for D4 (number by the plan) that amends ADR-0014 (a lookup endpoint after all) and gives ADR-0012's safe fetcher its second user; ADR-0014's status line says so. | Accept |
| 14 | Until an api has loaded the toml directory once, a domain gives no display name (unknown is not "not verified"); a failed `account_domains` read fails the batch (500) rather than answer without domains. | Accept |

### Explorer — `2026-10-24-display-names-design.md` (13 rows)

| # | Choice | Recommendation |
|---|---|---|
| 1 | A names call that fails or is late (1.5 s) never fails a page: it shows addresses, as today, and is served and not stored (degraded), with a log line. | Accept |
| 2 | A page of class `immutable` that shows names (a transaction, a closed ledger) is kept at the edge 1 hour (`NAMED_PAGE_TTL_SECONDS`), not a year, while `NAMES` is on, so a new label or name shows within about an hour. | Accept |
| 3 | One names call per awaited part and one per streamed section that shows accounts: the account page makes two (header, list); its Analytics view one per card with accounts. One call for the whole page would hold the header for the list. | Accept |
| 4 | At most 400 addresses of a page get names (four calls of 100 side by side); the rest show addresses (a ledger with more than about 200 transactions). | Accept |
| 5 | A link reads the display name, then ` · ` and the account network name when there is one, for every kind (the board does this for "Harborline Exchange · hot wallet"). | Accept |
| 6 | The hover title of a verified name names its domain, "Verified by northpeak.example · r…", where the board says "Verified name · r…": a toml's `desc` can claim any name, the domain cannot be faked. | Accept |
| 7 | Server-built text: the account page's own title, description and link-preview card use its name when it is verified or named by GateHub, and say a label in words; transaction and ledger titles, cards and the sentence summary (`plainText`) keep short addresses; a chart label that links to an account shows the name and its mark; issuer texts in a page's body use the name when verified or named by GateHub and unlabelled. | Accept |
| 8 | "How we know" is closed by default; the board draws it open. | Accept |
| 9 | The domain is a link (`rel="noopener noreferrer nofollow"`) only when it is verified; an unverified domain is text (the Account board links it). | Accept |
| 10 | The toml facts (principals, currencies, last modified) are shown for a verified domain only. Currencies are plain text until E11 makes them token links. | Accept |
| 11 | "Ask GateHub to change it" needs a URL from the owner (`NAME_REQUEST_URL` in `app/ui/brand.ts`); without one the sentence has no link. | Owner to give the URL |
| 12 | Labels: one warning banner per label on the labelled account's page (title, description, source, link), and a warning mark beside the name or address everywhere. The boards do not draw either. | Accept |
| 13 | `NAMES` is `"off"` in the sandbox and production until that environment's data API has D4 deployed, its seed run and its first toml sweep done (`syncer_tomls_due` near 0). | Accept |

## 4. Escrow, check and payment channel pages; delegation

### Data API — `2026-10-24-ledger-objects-delegation-design.md` (16 rows)

| # | Choice | Recommendation |
|---|---|---|
| 1 | One generic ledger table, `object_changes` (the ledger-features table), holds the history of `Escrow`, `Check`, `PayChannel` and `Delegate`. Its `check_events` table is folded into `object_changes.event` / `event_fields` (escrows and channels need the same per-transaction facts), and its `accounts` array becomes `owner` + `counterparty`, with a `role` in the account index. | Accept |
| 2 | An object's state and history are read **at query time** from `object_changes` (exact, no aggregator lag). The only aggregate is `escrows`, kept for D7's escrowed total. | Accept |
| 3 | An escrow named by owner and sequence (as `EscrowFinish` names it) is resolved by computing its ledger object ID (no table): `GET /v2/accounts/{address}/escrows/{sequence}`, beside `/transactions/{sequence}`. The list `/v2/accounts/{address}/escrows` stays 404 (ADR-0010 item 7). | Accept |
| 4 | The API serves a time-derived `status` (`pending`, `can_be_finished`, `can_be_cancelled`, `expired`, `closing`, …), evaluated at the close time of the newest indexed ledger, which every answer names. | Accept |
| 5 | A detail answer embeds the **newest 50** events of the object; older events are paged through `/history`. Escrows and checks have at most a few events; a busy payment channel has thousands. | Accept |
| 6 | A payment channel whose `CancelAfter` or `Expiration` has passed but which is still in the ledger is `closing` (any transaction on it closes it). The board has no separate state for it. | Accept |
| 7 | The API has **no node fallback**: an object the index has no row of answers 404, and the explorer asks the node (`ledger_entry`). | Accept |
| 8 | The `Delegate` field is indexed by listing the delegate under its own account in `account_transactions` (always, even when its account root is not in the metadata), not by a new column or filter. The account-transactions CSV gains a last column `delegate`, and its `fee` moves to the row of the account that paid it. | Accept |
| 9 | **Bug fix:** today a delegated transaction's fee row in `balance_changes` (`transaction_cost`) is put on `Account` although the delegate paid it. It moves to the delegate. Needs a re-ingest from the delegation amendment (row 13). | Accept |
| 10 | On Xahau (no delegation) `/v2/accounts/{address}/delegations` answers an empty list with `complete: true`, not 404. Escrows, checks and channels are served on both networks. | Accept |
| 11 | The route is `/v2/accounts/{address}/delegations?direction=given\|held` (the brief), not the ledger-features spec's `/delegates?role=delegator\|delegate`. Rows keep the ledger's names `account` and `authorize`. | Accept |
| 12 | `GET /v2/ledger_objects/{id}`, a type lookup of any tracked object, so the explorer's search can send a pasted object ID to its page. | Accept |
| 13 | Rollout re-ingests (`--reprocess`) from 107,524,865 (PermissionDelegationV1_1) to the deploy ledger: delegation is then complete. Escrows, checks and channels stay incomplete (their `coverage` says so) until the history backfill reaches 28,685,313; no extra backfill in D5. | Accept |
| 14 | Coverage is D3's `FeatureCoverageService` (D3 §4), with four features keyed by `OBJECT_PARSER_VERSION` and the amendments Escrow, PayChan, Checks and PermissionDelegationV1_1; one object's history is complete when the feature's is or when its creation is indexed (D3's per-NFT rule). Xahau's amendments file gains the genesis ledger for Escrow, PayChan and Checks, as D3 does for URIToken. | Accept |
| 15 | Issued-token payment channels (Xahau, `PaychanAndEscrowForTokens`) are typed in `balance_changes` with token amounts; today `channel()` reads every amount as drops. | Accept |
| 16 | **Consistency pass:** D5 defines the MPT amount object of the data API's answers (section 5.1); D9, built later, serves MPT amounts in this shape and adds the scale and ticker through its `?ids=` batch, without changing it. | Accept: D5 serves MPT escrow amounts before D9 exists. |

### Explorer — `2026-10-24-ledger-object-pages-design.md` (14 rows)

| # | Choice or deviation | Recommendation |
|---|---|---|
| 1 | Routes are plural, as the brief names them (`/{net}/escrows/{id}`, `/{net}/checks/{id}`, `/{net}/payment-channels/{id}`), unlike the singular `account`, `tx`, `ledger`. Plus `/{net}/escrows/{owner}/{sequence}`, a redirect to the escrow's ID (how `EscrowFinish` names it). | Accept |
| 2 | The board's "All escrows →" link is left out: the network-wide list is deferred. | Accept |
| 3 | The board's "States" strip is labelled "Mock only"; it is built as a static legend of the type's states with the current one marked, not as a switch. | Keep it (or drop it) |
| 4 | The board's "Read live at ledger #N" becomes "As of ledger #N, {time}" for what the index serves; "Read live from the network" is said only of an object read from the node. | Accept |
| 5 | The "Sent by" row, the "sent it on behalf of" sentence and the `DelegateSet` sentences come from the transaction itself and are shown whatever `DELEGATION` says; only the links into the Delegation tab are gated. | Accept |
| 6 | Wording: "Harborline Ops sent it on behalf of Northpeak Treasury." (the brief's words) instead of the board's "…on Northpeak Treasury's behalf", which reads badly after an address with no name. | Accept |
| 7 | The Delegation tab has no count in its label (the API has no totals, as for the other tabs), and each of its two lists shows up to 200 rows without paging ("Showing the first 200" when there are more). | Accept |
| 8 | An object page shows the newest 50 events of its history (oldest first among them), with Newer and Older links for the rest; the board shows every event. | Accept |
| 9 | No link-preview image for the object pages (meta tags, `twitter:card=summary`, as the home page); images can be added later as kinds of the image route. | Accept |
| 10 | "Owner reserve" is the network's current owner reserve (`server_state`), also on a removed object, with the board's words for "released". | Accept |
| 11 | The Objects tab names the source ("From") of an incoming escrow, check or channel (the account is its destination) and lists the account's `Delegate` entries with a link to the Delegation tab. | Accept |
| 12 | A payment channel past its `CancelAfter` or `Expiration` but still in the ledger is shown as "Closing" ("any transaction on it closes it"); the board has no state for it (D5 decision 6). | Accept |
| 13 | Pill gains a `warn` tone (amber) for "Can be cancelled", "Expired" and "Closing", with the board's amber tokens (reused if E9 added them for labels). | Accept |
| 14 | **Consistency pass:** an MPT amount (a token escrow's) is drawn by a minimal `MptAmount` defined here (the issuance ID and the integer value, raw, "2,500,000 units of MPT 0000012A…"); E14, built later, extends it with the scale and ticker from `GET /v2/mpt?ids=` and the link to its MPT page. | Accept: E10 shows MPT escrows before E14 exists. |

## 5. Token list and issued token page

### Data API — `2026-10-24-issued-tokens-design.md` (16 rows)

| # | Choice | Recommendation |
|---|---|---|
| 1 | **A token** is a (currency, issuer) with at least one trust line on which the other account holds it or trusts the issuer (§1). A line on which the "holder" owes counts for the other side's token. | As written: it is how `gateway_balances` sees an issuer. |
| 2 | **Holders** are lines with a positive balance; **trust lines** add those with a zero balance and a limit above 0; **supply** is the sum of the holders' balances (the issuer's obligations). | As written. "Supply", not "circulating": that word is the native currency's (glossary). |
| 3 | **LP tokens are not tokens here** (currency `03…`): they are left out of the aggregate; their page is the pool's. | As written. |
| 4 | **A new ledger table, `state_touches`, and a new parser version**, to find what changed since the job's cursor without scanning the state tables (§2.1). Reading `transactions.meta_json` in the job instead was weighed (§2.1). | The touch table: the `amm_pool_touches` precedent (Ruling R-A14). |
| 5 | **The aggregate is built in generations**: a full build from `trust_line_states`, then kept current from the touches; a config change or a change of the state coverage builds a new generation beside the live one and swaps it in whole (§3). | As written. |
| 6 | **Price and 24 h volume are read at request time** from the `markets_live` sets, not stored in the token rows. Price: the last trade against the native currency in the `day` set, else in the `30day` set; the 24 h change only from the `day` set (§5.5). | As written. A token that has not traded against the native currency in 30 days has no price. |
| 7 | **The list is ranked by holders**, then issuer and currency, with a `rank` per row; the marker is a cursor into a ranking that moves each minute (as `/v2/amm/pools`). | As written. |
| 8 | **`totals` use a fixed floor of 10 holders** (`tokens_with_10_holders`), whatever the request's `min_holders`; `totals.holders` counts accounts holding any issued token; `totals.native_volume` is the whole `day` markets set. | As written: the boards' tiles do not change with "Show all" or a search. |
| 9 | **Search (`q`)** matches the display code, the toml name, the issuer's domain, the 40-hex currency and the issuer address; not the issuer's display name (that is the explorer's names call). | As written. |
| 10 | **"Listed in the issuer's toml"** is two-way: the issuer's account domain (D4), and that domain's toml (D4's store) has a `[[CURRENCIES]]` entry with the token's code and issuer that counts on this network (D4's `countsOn`). | As written. |
| 11 | **No node fallback** for a token the index lacks: 404 `token not found` (the explorer adds a coverage note). `gateway_balances` is heavy for big issuers and gives no holders. | As written. |
| 12 | **Transfers** are the payments that delivered the token (`payments_by_currency`), payments to oneself left out as in `/v2/payments`. | As written. |
| 13 | **Holder shares** are fractions of the supply with 6 decimals, rounded half up (`"0.117300"`). | As written. |
| 14 | **No supply or holders history** (the board's two charts): they need a daily statistics job, deferred by the owner. | Deferred. |
| 15 | **A new ADR** (the next number) for the touch index and the generations; ADR-0010 gains items for the four routes. | As written. |
| 16 | **Coverage is D3's `FeatureCoverageService`**, with D3's case of a feature without an amendment (trust lines, payments): its start is the network's first ledger, `NetworkProfile.firstLedger` (§6). Consistency pass: D3 defines that case (it builds the service first); D6 adds nothing to it. | As written. |

### Explorer — `2026-10-24-token-pages-design.md` (18 rows)

| # | Choice | Recommendation |
|---|---|---|
| 1 | The board's "Supply over time" and "Holders over time" charts, the Holders tile's "+N in 90 days" and the `…/stats?interval=day` captions are left out: they need a daily statistics job (owner's cut). | Deferred. |
| 2 | The token page's first tile reads **"Supply"**, as the list's column, not "Circulating" (the glossary's word for the native currency less escrow). | As written. |
| 3 | The toml card reads the token answer's `toml` (`/v2/tokens/{token}`, built by D6 from D4's toml store), without a second call to D4's `/v2/toml/{domain}`; the entry's `icon` is a link, never drawn (no third-party image on the page). | As written: one call, the same store. |
| 4 | "Order book pairs" becomes **"Markets"**: the token's pairs of the last 24 h (DEX and AMM trades) from the token answer, one call, not a `reduce` per pair. | As written. |
| 5 | The AMM pools card shows the 5 most valuable pools with the token (`/v2/amm/pools?asset=`), their 24 h volume from the live AMM volume, and "All pools with {CODE} →". | As written. |
| 6 | Price is the last trade against the native currency in 24 h, else in 30 days ("last trade Oct 3"), else "—"; the change only from 24 h. | As written. |
| 7 | List tiles: "Holders" counts accounts holding **any** issued token; "Volume, 24 h" is the whole DEX's (every pair). | As written (D6 decision 8). |
| 8 | 20 tokens a page (the board shows 12); the search is a GET form answered by the API; "Show all" is a link (`?all=1`). | As written. |
| 9 | Ranks come from the API; the list is a ranking rebuilt every minute, so a token can move between pages. | As written. |
| 10 | "All N holders →" opens `/{net}/token/{token}/holders`, 50 a page. | As written. |
| 11 | Recent transfers: 20, newest first, Older/Newer on the token page (`?marker`), rows from or to the issuer tagged "Issued" / "Redeemed". | As written. |
| 12 | A token the index does not know is a 404 with a coverage note and the issuer's account (no node fallback); the issuer's settings come from the node when the index has none. | As written. |
| 13 | An LP token's URL redirects to its pool page. | As written. |
| 14 | The MPT tab is drawn disabled: "soon" on XRPL until E14, the board's note on Xahau. | As written. |
| 15 | Links into token pages: the account page's Tokens card (a line the account owes on links to the account's own token), the "issued by" lines of the pair and pool pages, and a search for `CUR.issuer`. | As written. |
| 16 | "Tokens" sits in the header after Transactions, before Network (the boards' "Accounts" item is not built; E8 §1.1 gives the header's three steps). | As written: the board's place. |
| 17 | A link-preview image for a token (`/og/{net}/token/{token}.png`). | As written. |
| 18 | E8's `CoverageNote` under the list, the token's figures, its holders and its transfers while their coverage is not complete. | As written: E8's one note. |

## 6. Supply

### Data API — `2026-10-24-supply-design.md` (12 rows)

| # | Decision (and deviation from the board) | Recommendation |
| --- | --- | --- |
| 1 | One route, `GET /v2/network/supply`, answers the newest **snapshot**: every figure computed at one ledger by an aggregator job that starts a new cycle every hour (the board's "updated hourly"). Not live, no `ledger_index` parameter. | Keep |
| 2 | XRPL burned is exact from the ledger header (100,000,000,000 XRP − `total_coins`) and carries no `coverage`. Xahau has no cap, so its burned is the sum of every indexed ledger's fees, with `coverage`. | Keep |
| 3 | Account reserves are what accounts **must keep**: accounts × base reserve + Σ `OwnerCount` × owner reserve, at the reserve values in force at the snapshot ledger. Not Σ min(balance, requirement): a few accounts hold less than their requirement after paying fees. AMM pool accounts (pseudo-accounts, no reserve) are left out of the count. | Keep |
| 4 | Escrowed counts native escrows only (D5's sentinel): token escrows (XRPL TokenEscrow, Xahau issued-token escrows) are not supply. Native currency in payment channels counts as circulating (the glossary's definition). | Keep |
| 5 | Xahau minted, by source: **rewards** = every entry of a `GenesisMint` whose parent (`EmitDetails.EmitParentTxnID`) is a `ClaimReward` (the governance members' share of a reward included); **genesis_mint** = every other `GenesisMint`; **import** = what an `Import` credits (the burned XRP, scaled by xahaud's B2M schedule, plus the starting bonus of an account it creates). The supply the network started with (XahauGenesis) is not minted. | Keep |
| 6 | Minted per day by source is served (the board's stacked chart): it is a cheap query over the three tables this spec adds anyway, `GET /v2/network/supply/minted?interval=day`. Burned per day needs no route: the explorer reads the existing `/v2/network/fees?interval=day` (`total`), not the board's `/v2/network/supply/burned`. | Keep |
| 7 | `reward_claims` is ordered by ledger (P6), not by account as family 5 has it, so that the reward test is a range join; family 5 adds its per-account index when it is built. `imports` holds only what supply needs; family 5 adds its decoded-blob columns. | Keep |
| 8 | Before the first snapshot the route answers 404 `supply not computed yet`. | Keep |
| 9 | Snapshots are kept (one row an hour, no TTL); only the newest is served. A supply-over-time chart (deferred) could read them later. | Keep |
| 10 | Reserve values come from `network_state` (D1) at the snapshot ledger, else from the newest `SetFee` in the index; with neither, `reserves` is left out of the answer. | Keep |
| 11 | Each history-derived part carries its own `coverage` (D3's shape and service), not one for the answer: on XRPL total and burned need no history while reserves will stay incomplete until the history spec. | Keep |
| 12 | **Consistency pass:** on XRPL `/v2/network/supply/minted` answers its empty list with `coverage` `complete: true` (D3's rule for a feature the network cannot have, as D5 and D9 do), not without `coverage`. | Keep: one rule for every list. |

### Explorer — `2026-10-24-supply-page-design.md` (14 rows)

| # | Decision (and deviation from the board) | Recommendation |
| --- | --- | --- |
| 1 | The page is "Supply" at `/{net}/supply`, its menu item "Supply", with no Supply / Distribution tabs: Distribution is deferred. | As the brief |
| 2 | No "Escrow releases by month" card and no "All N escrows →" link (both deferred); the Escrowed tile says "in 12,879 escrows" instead. | As the brief |
| 3 | The burned chart's source line is `/v2/network/fees?interval=day` (the data that already exists), not the board's `/v2/network/supply/burned`. | Keep |
| 4 | "Last 90 days" is today so far and the 89 days before it, today marked "so far", as on every page of the explorer (program 1, decision 4), not the board's 90 full days to yesterday. The average and the highest day use the 89 full days. | Keep |
| 5 | The circulating segment is series colour 1, not the network accent: the kit's segments take series slots, and the accent is not one. Burned 2, escrowed 3, as the board. | Keep |
| 6 | On Xahau the escrowed segment (about 3%) has no label under it (the kit labels a segment of 18% or more); the legend, the tooltip and the tile name it. | Keep |
| 7 | The bar has no Table view: every segment's exact figure is a tile right under it. | Keep |
| 8 | Xahau's "Minted, last 90 days" tile sums the minted days; the minted card adds one line from the snapshot: "Since ledger #N: M XAH minted: R as rewards, I by Import, G by GenesisMint." | Keep |
| 9 | The Network menu is a **disclosure** (`<details>` / `<summary>`, links inside), not an ARIA `menu`: site navigation, works before JavaScript, Tab moves through it. Items: Overview, Validators, Amendments, Supply; Nodes is not listed (not built). An item whose switch is off reads "soon". | Keep |
| 10 | Validators and Amendments get header entries for the first time (today only the network page links them). | Keep |
| 11 | `SUPPLY` goes on in an environment once its data API serves a snapshot on both networks **and** escrowed is complete there (D5's history from 28,685,313); reserves may still be incomplete, with their note. An incomplete escrowed figure would make the headline circulating supply billions too high. In the sandbox, whose coverage is never complete (D-env §12), it goes on with the snapshot alone and the notes (E7 §9, decision 15; consistency pass). | Keep; or turn on with the notes alone |
| 12 | A snapshot more than 3 hours older than the newest ledger shows a warning under the snapshot line. | Keep |
| 13 | The page is not live: it is class `slow` for 300 s, its calls kept 300 s; the snapshot itself changes hourly. | Keep |
| 14 | The page is a dashboard under ruling R19: budget 160,000 bytes, as the network page (the brief's flat 150 KB was wrong). | Accept |

## 7. Validators map

### Data API — `2026-10-24-validator-toml-details-design.md` (11 rows)

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Every fact comes only from a toml that **verified** (the manifest names the domain, and the file's `[[VALIDATORS]]` lists the master key), as D1's accounts do. An unverified domain's file is never read for anything, so its validator has an unknown location. | Keep |
| 2 | Country codes: the ISO 3166-1 alpha-2 codes assigned on 2026-10-24 plus `XK` (Kosovo, widely used, user-assigned); any case and surrounding spaces accepted; `UK` is read as `GB` (ISO reserves it for the United Kingdom). Anything else (`Germany`, `DEU`, `EU`, `ZZ`) counts as not given and is never served. | Keep |
| 3 | `GET /v2/network/validators/countries` is built for API clients. The explorer (E13) counts its map from the list it already loads, so a country's count always equals the rows its click shows; tests pin the route equal to that count. | Keep; the explorer can switch to the route with one call if preferred |
| 4 | `/v2/network/validators` gains a `country` filter (a code, or `unknown`), so the route and the list agree for every client. | Keep |
| 5 | Principals: names only. A name that contains `@` is dropped; at most 10, in file order. Emails are never stored, logged or served. | Keep |
| 6 | The validators domain checker writes every check of a file it fetched into D4's per-domain store (`domain_tomls`), failures included, so a domain only a validator names is in the store, and loses its content there when its file goes (D4's `tomls` worker fetches account domains only, as D4 §4.1 expects). | Keep |
| 7 | Verified pairs checked before D8 are due again (`toml_version`), so details appear within minutes of the deploy (at most an hour for a pair checked just before it), not up to 6 h later. | Keep |
| 8 | The toml's `network` and `unl` are served as the store keeps them (cleaned; `network` lower-cased by D4), as the toml's claims. Nothing checks them, a `unl` URL is never fetched, and the validator's entry is not filtered by D4's `countsOn` (the master key already names the validator; a `network` naming another network is shown, so the explorer can say so). | Keep |
| 9 | `toml` is the last key of a validator row, after `last_seen` (D1's order unchanged), and is `{}` when a file that verified gives none of the four fields. | Keep |
| 10 | The countries route's default scope is `unl`, like the list's. | Keep |
| 11 | The decision is recorded as an amendment of ADR-0012 (it changes what ADR-0012 says is read of a toml), not a new ADR. | Keep |

### Explorer — `2026-10-24-validators-map-design.md` (13 rows)

| # | Decision (and deviation from the board) | Recommendation |
| --- | --- | --- |
| 1 | The map and the countries table are counted in the Worker from L (`scope=all`, `limit=1000`), which the page already loads, instead of calling `/v2/network/validators/countries`: a country's figure is always the number of rows its click shows. The card's source line reads `/v2/network/validators`. | Keep |
| 2 | A circle and a country's name in the table are **links** (`?country=DE`), with `aria-current`, not `<button aria-pressed>`: a URL per view (E6's rule), and it works without JavaScript. | Keep |
| 3 | The map is one Tab stop; the arrow keys move between circles, west to east. The table holds every country as a link and is the full keyboard and screen-reader path. | Keep |
| 4 | A circle's **area** is proportional to its count (diameter 44 px × √(n / largest), at least 10 px), not the board's 10 + 34 × √(n / largest), which makes one validator look a quarter of 27. The legend's "Circle area shows the count" is then true. | Keep |
| 5 | The map always counts every validator of All, whatever the UNL / All chip; a click keeps the chip. On UNL, a country with no UNL validator shows "No validator in {country} is on the default UNL" and a link to All. | Keep |
| 6 | "Unknown location: N" links to the validators without a location (`?country=unknown`), and "Unknown location" is the last option of the Country select. | Keep |
| 7 | The attribution names only the toml (no DB-IP sentence: nodes are not built). | As the brief |
| 8 | Every ISO country has a point (the World Factbook's public-domain coordinates; the board's 55 hub points kept). A code the explorer's table lacks gets a table row named by its code, no circle, and a note under the map. | Keep |
| 9 | The toml card is drawn only for a verified domain (the note under the heading already says why another is not). A fact the toml leaves out is not drawn, except Server country ("Not given"), which explains an unknown location. | Keep |
| 10 | No "Servers [[SERVERS]]" cell (nodes deferred). Accounts: every account D serves (up to 10) with its display name, "and N more" only beyond them, not the board's two and "and 1 more". The card's source line is `/v2/network/validators/{key}`, not `/v2/toml/{domain}`. | Keep |
| 11 | "Network": the toml's value as written, with a name for the known values ("XRPL mainnet") and ", not this network" when it names another. "On a UNL, says the toml": the host of its `unl` URL, as text, never a link. | Keep |
| 12 | The dots are a static asset (`/assets/world-dots-<hash>.svg`) drawn with `<use>`: no byte of the 32 KB path in any page's JavaScript or HTML, one request cached for a year. | Keep |
| 13 | The countries card holds the live page while the pointer or keyboard focus is in it, as the live tables do. | Keep |

## 8. MPT page

### Data API — `2026-10-17-mpt-data-design.md` (17 rows)

| # | Choice | Recommendation and why |
|---|---|---|
| 1 | Changed: the routes are the boards' captions, `/v2/mpt/{issuanceId}`, `/holders` and `/transfers`, not `/v2/mpt/issuances/:id` and `/history`; the list is `/v2/tokens?kind=mpt` (D6), and `/v2/mpt/issuances` is dropped (section 7). | Yes: one list of tokens for both kinds, at the paths the explorer's captions name. |
| 2 | Changed: no `mpt_daily` table and no `/stats` route. | Yes: the holders-over-time chart is deferred (brief), and nothing else on the boards needs daily rows. |
| 3 | Changed: no `mpt_holders_by_amount` version set; top holders are sorted when read, over the issuance's current holders (section 7.3). | Yes: rewriting a by-amount set on every touch of a big issuance costs more than the read. The read grows with the issuance's holders; past ~500k holders, bring the set back. |
| 4 | Changed: no MPT payment volume (`paymentCurrencies` stays issued-token only). | Yes: the parser cannot scale an amount (the issuance node is not in a holder-to-holder payment's metadata), and no board shows it. |
| 5 | Changed: a balance change of an MPT is two rows, the holder's and the issuer's mirror, as for a trust line (section 4.3), not one issuer row from `OutstandingAmount`. | Yes: an MPT issuer's rows read as an issued token's issuer's rows do, and each currency of a transaction sums to zero. |
| 6 | New: `GET /v2/mpt?ids=` (1–100 issuance IDs): the ticker, name and scale of each, in request order (section 7.5). | Yes: the explorer shows MPT amounts on transaction and account pages and needs the scale; one call per page, as for names. |
| 7 | Two meanings of "locked": `escrowed_amount` is the ledger's `LockedAmount` (in escrow); `locked_amount` is what the issuer has locked (the board's Locked tile). | Yes: the board's tile means the issuer's lock; the ledger field means escrow. |
| 8 | `change_type: "clawback"` for every row of a `Clawback` transaction, issued tokens included (they had none). | Yes: one word per transaction type. |
| 9 | The metadata (XLS-89) is decoded by the aggregator, leniently: long and short keys, and the early draft's `urls`; `metadata_conforms` says whether it follows XLS-89; the hex is always served (section 5). | Yes: the list's search and the ticker need it server-side; lenient because early issuances predate the final keys. |
| 10 | A transfer's `kind` is `payment` (mints and redemptions included), `clawback`, `lock`, `unlock`, `escrow_create`, `escrow_finish` or `escrow_cancel`. Authorizations and issuance changes are not listed. | Yes: the board lists moves, clawbacks and locks; the account's transaction list has the rest. |
| 11 | MPT amounts stay in the ledger's integer units everywhere (`"124000000"` is 1,240,000.00 at scale 2), with `asset_scale` on issuance objects and `mpt_issuance_id` on amounts (kept from 2026-10-17). | Yes: exact, and the scale is not known where a payment is parsed. |
| 12 | Exchanges, AMM pools and path payments still skip MPT amounts (kept, ruling R12). | Yes: MPTokensV2 (MPT on the DEX) is not enabled. |
| 13 | An issuance whose own ledger entry did not change inside the coverage (created before it, moved only between holders since) has no known state: `/v2/mpt/{id}` answers 404 and the list leaves it out until the reprocess (section 10). | Accept: it ends with the reprocess from the enablement ledger; the explorer falls back to the node. |
| 14 | `/v2/accounts/{address}/mpt` (kept) serves the newest indexed ledger only, with no historical ledger parameter. | Yes: the explorer reads holdings from the node; a historical form can come later. |
| 15 | A brand-new issuance answers 404 on `/v2/mpt/{id}` until the next aggregator tick (about 30 s), as a new AMM pool does. | Accept. |
| 16 | Coverage is D3's `FeatureCoverageService` (`MPT_PARSER_VERSION`, MPTokensV1). On Xahau (`NetworkProfile.hasMpt` false) the routes read nothing and answer `complete: true`: D3's rule for a feature the network cannot have, as D5 applies it to delegation (section 7). | Yes: nothing can be missing where MPT cannot exist. |
| 17 | **Consistency pass:** the MPT amount object is D5's (D5 §5.1: `{ currency: <issuance ID>, issuer, value: <integer units>, mpt_issuance_id }`), built before D9; D9 serves every MPT amount in it and adds the scale and ticker only through `?ids=` (section 7.5). `/v2/accounts/{a}/mpt` puts `coverage` right after `result` (D3's placement), not after `close_time`. | Yes: D5 and E10 show MPT escrows before D9 exists; one placement for every list. |

### Explorer — `2026-10-24-mpt-page-design.md` (17 rows)

| # | Choice | Recommendation and why |
|---|---|---|
| 1 | **Deferred:** the board's "Holders over time" card is left out; the Holders tile's line reads "accounts holding HTF" instead of "+N in 90 days". | As the brief: the chart needs a daily statistics job. |
| 2 | The Locked tile is what the issuer has locked (D9 `locked_amount`); an amount in escrow (the ledger's `LockedAmount`) is added to its line when above 0 ("…; 12,000.00 HTF in escrow"). | Yes: the board's wording, and escrow is a different thing. |
| 3 | The Flags card's intro is "What the issuer allows, as the issuance says now." instead of "Set when the issuance was created. They cannot change."; "Can trade" reads "The issuer allows HTF on the DEX. MPT trading isn't enabled on XRPL yet." (and the list's Trade pill title likewise). | Yes: DynamicMPT (possibly on XRPL Testnet) lets flags change, and MPTokensV2 is not enabled. |
| 4 | "All 3,412 holders →" and "Older →" open pages of their own, `/{net}/mpt/{ID}/holders` (50 a page) and `/{net}/mpt/{ID}/transfers` (20 a page), with Newer and Older. | Two pagers cannot share one URL (E8's rule). |
| 5 | MPT amounts outside the MPT page (a transaction's sentence, flow, details and balance changes; an account's Transactions and Payments tabs and Tokens card; an escrow's amount) are scaled and named by ticker from one `GET /v2/mpt?ids=` call per page. Without an answer they read "2,500,000 units of MPT 0000012A…". | Yes: the amounts are the ledger's integers; the scale lives in the issuance. |
| 6 | An account's MPT holdings go on its **Tokens card**, read from the node's `account_objects` (the `MPToken` entries the page already loads), not from the index's `/v2/accounts/{a}/mpt`. Issuances the account owns are counted ("MPT issuances") and listed on the Objects tab, each linking to its page. | Yes: current and complete, no new call; the index's list has a coverage. |
| 7 | **Node fallback:** when D9 answers 404, the page reads `ledger_entry` (`mpt_issuance`): header with the issuance ID, the tiles but Holders, the flags, and the metadata as hex (and its text when it is UTF-8 text, not decoded as XLS-89), under "Not in the index yet, shown from the network". Holders and transfers are still asked of the index. | Yes: the brief's node rule; one metadata decoder (the API's). |
| 8 | Metadata links: only `https://` URLs and `hostname/path` (read as `https://`) are links, with `rel="noopener noreferrer nofollow ugc"`; anything else is text. The icon is a link, never loaded. | Yes: the metadata is the issuer's, unchecked. |
| 9 | The transfers' Kind words: Transfer (payments, issuing and redeeming, as the board's footnote says), Clawback, Lock, Unlock, Escrow, Escrow finished, Escrow cancelled. | The board's words, with the kinds it did not show. |
| 10 | Search: 48 hex digits go to `/{net}/mpt/{ID}` without a call (nothing else is 48 hex digits). | Yes. |
| 11 | Xahau: `/xahau/mpt/{ID}` is the board's "MPT isn't enabled on Xahau" page as a 404 (class `short`, no call) with "Open it on XRPL"; the MPT tab is disabled with "MPT isn't enabled on Xahau." and `?kind=mpt` there is a 302 to the issued list. | The board, with a status that says nothing is there. |
| 12 | A link-preview image for the MPT page (kind `mpt`); the holders and transfers pages have tags without an image. | As E5 and E8 (images of things). |
| 13 | A `Clawback` sentence for issued tokens too ("clawed back 50 USD from {holder}"), since the type had none. | Yes: one handler per type. |
| 14 | No page polls. Classes: the MPT page and the MPT tab `minute`, from the network `short` (60 s), behind a marker `MARKER_PAGE_CLASS`. | D9's aggregate changes at the aggregator's tick; nothing on the boards is live. |
| 15 | The MPT tab's search is the API's `q` (a GET form), not the board's filtering of one page. | As E8 decision 6. |
| 16 | `MPT` goes on in an environment once D9 is deployed there and its `syncer_mpt_state_lag_ledgers` is near 0, before the reprocess has made the coverage complete. | The coverage notes say what is missing (E8 decision 17). |
| 17 | **Consistency pass:** `MptAmount` is E10's minimal component (issuance ID and integer value, raw), which E14 extends with the scale, the ticker and the link; the 48-hex search is an extension of E8's search sequence. | E10 is built first and shows MPT escrows; one search sequence for the program. |
