# Post-2021 amendments: roadmap

Date: 2026-10-17. Status: proposed.

This roadmap covers the transaction types and ledger objects enabled on XRPL and Xahau mainnet since the original Ripple Data API's last commit (May 2021). The inventory is in the "Context" table of `2026-10-17-amm-data-design.md`.

The work is split into five families. Each family has its own spec and plan, and they run in this order:

| # | Family | Spec | Plan | `PARSER_VERSION` |
|---|---|---|---|---|
| 1 | AMM | `2026-10-17-amm-data-design.md` | `../plans/2026-10-17-amm-data.md` | 2 |
| 2 | NFTs and URITokens | `2026-10-17-nft-data-design.md` | `../plans/2026-10-17-nft-data.md` | 3 |
| 3 | MPTokens | `2026-10-17-mpt-data-design.md` | `../plans/2026-10-17-mpt-data.md` | 4 |
| 4 | Ledger features: oracles, identity, clawback, checks, token escrows, domains, tickets, batch | `2026-10-17-ledger-features-design.md` | `../plans/2026-10-17-ledger-features.md` | 5 |
| 5 | Xahau-native: hooks, rewards, import, remit, cron, remarks | `2026-10-17-xahau-native-design.md` | `../plans/2026-10-17-xahau-native.md` | 6 |

## Why this order

- **AMM** changes `/v2/exchanges`, so every exchange-based Ripple endpoint depends on it.
- **NFTs** are the second-largest activity on both networks. The Xahau URIToken part also covers URITokens moved by `Remit`, which the Xahau family relies on.
- **MPTokens** extend the asset model of payments, balance changes and escrows. The ledger-features family types IOU escrows next to the MPT ones built here.
- **Xahau-native** comes last because it uses the URIToken events (family 2) and the generic object-change table (family 4).

## Shared rules for every family

These come from the drop-in work and stay binding. Its rulings are in `../plans/2026-10-15-ripple-dropin.rulings.md`.

**Ingest**
- Parsers are pure, take deep-frozen input and a `ParseContext`, and plug into `buildLedgerRows`. Every new family bumps `PARSER_VERSION` once.
- A table written by ingest is a ledger table:
  - it is listed in `CHILD_TABLES` and `LEDGER_KEYED_TABLES`;
  - it is written through `LedgerWriter`, with dedup tokens, child tables first and `ledgers` last;
  - recovery and range-ingest redo delete it partition by partition;
  - it has `non_replicated_deduplication_window`.

  Keys are `ledger_index`-ordered, using P6 or P7 partitions.
- Current-state views are never kept up to date by ingest. The aggregator rebuilds them from append-only history, as with `amm_pools`. So a recovery delete can never lose a state once ReplacingMergeTree merges have dropped the older rows.

**Aggregation**
- The aggregator's new jobs use version sets, the R86 finality rule (driven by ingest progress), budgets (R83) and failed-last ordering (R87).
- Daily-stats jobs run on a cadence of once per N ticks, not every tick. This keeps the 30-second tick from being over-committed. Each family's plan proves that the live volume jobs are not starved with all of the families' jobs registered.

**API**
- Every new route uses the Ripple contract layer: errors, API key, markers, the `Link` header, CSV and `limitParam`.
- Paged reads go through `readDistinctPage` (R106), with EXPLAIN and `read_rows` bound tests.
- Object key order is pinned by tests.
- A route that exists on one network only answers an empty list or 404 on the other.

**Fixtures and verification**
- Each family records real mainnet fixtures first, with the `--txs` mode added in AMM Task 1, at most 2 requests in flight. Every unconfirmed metadata assumption is written down in a `FINDINGS.md`.
- Each family ends with a bounded live check against the node.

**Docs**
- Each family gets an ADR, updates to `docs/api-reference.md`, `docs/data-model.md`, `docs/syncer.md` and `docs/operations.md`, and a regenerated `docs/openapi.yaml`.
- Deliberate deviations from data.ripple.com go into ADR-0010.

**Rollout**
- The baseline schema is changed in place while nothing is deployed.
- After the last family, one `range-ingest --reprocess` from the earliest enablement ledger fills all history. That ledger is NegativeUNL / TicketBatch, November 2021, for XRPL; for Xahau it is genesis.

## Out of scope for the whole program

These amendments are not enabled on mainnet: XChainBridge, SingleAssetVault, LendingProtocol, Sponsor, ConfidentialTransfer, MPTokensV2 (the MPT DEX), Batch v1 and PermissionDelegation v1.

Also out of scope: live node reads for current state, and snapshot imports of objects that existed before ingest.
