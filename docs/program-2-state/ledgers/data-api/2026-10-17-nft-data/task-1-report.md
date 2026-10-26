# Task 1 report (saved by the controller from the implementer's message; the implementer could not write report files)
Recorded with `record-fixtures --txs --delay-ms 75`:
- XRPL `wss://s2.ripple.com`, 2026-10-26, head 107917324: ledgers 107874617, 107878775, 107878781, 107879497, 107879890, 107881530, 107883082, 107883610, 107886001, 107886163, 107886233 (15 cases).
- Xahau `wss://xahau.network`, 2026-10-26, heads 26811086/26811277/26811706: ledgers 26533927, 26689211, 26763618, 26763629, 26763778, 26765431, 26768773, 26771798, 26774724 (8 cases).
Scans (throwaway scripts in ignored .superpowers/scan/): XRPL 19,955 ledgers (stopped by node load limit), Xahau 49,999 ledgers (17,072 bursts counted by hash only).
Not found -> synthetic: `offer_removed_other` (XRPL), `uritoken_mint_with_offer` (Xahau). `uritoken_buy_above_ask` = a buy at exactly the ask (allowed fallback).
Tests: RED = ENOENT manifest.json; GREEN pending FINDINGS.md (53/53 with a stand-in); shared unit 49/50 suites (only FINDINGS missing), build ok.
Deviations: extra test `shows what the case is for`; `uritoken_remint` has a `burn: {ledger, hash}` field (Task 5 needs it); weak cases noted (mints with offer all Amount "0"; direct buy-offer sales all 1 drop; sale_by_sell_offer has a third-party issuer).
Full facts: packages/shared/test/fixtures/{xrpl/nft,xahau/uritoken}/FINDINGS.md.
