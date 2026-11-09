# ADR-0021: Token history in ClickHouse: a token-ordered change log, checkpoints and hourly rollups, built by a worker of its own

**Status:** Accepted (2026-11-08, approved by the owner with the spec). Issue [#28](https://github.com/GateHubNet/data-api/issues/28); the design is
[the issuer analytics spec](../superpowers/specs/2026-11-08-issuer-analytics-design.md).
- Applies [ADR-0015](0015-historical-account-state-from-clickhouse.md)'s approach (state from the ClickHouse history, never from a node), [ADR-0019](0019-issued-tokens-from-state-history.md)'s
  generations and touch index, and [ADR-0008](0008-no-aggregate-materialized-views.md)'s rule (aggregates are tables a syncer worker writes) to the history of every token.
- Fills ADR-0019's deferred "supply or holders history".
- When it is built, the routes amend [ADR-0010](0010-ripple-v2-wire-compatibility.md) (Amendment 12).

## Context

Issuer analytics answers, for every issued token and MPT, at the head and at any ledger since the network's first: who holds it and how much, its supply, its holders
over time, how it was issued, redeemed, clawed back, transferred and traded. EURGH's MiCA reporting and reserve attestations need it exact and reproducible. The
facts that decide where and how it is stored:

- **The balances already exist.**
  - `trust_line_states` and `mpt_holder_states` hold every state of every trust line and `MPToken`, from `AffectedNodes`, and `countsFor` and
    `orientations` say who holds which token.
  - But they are ordered by account (or holder). The holders of one token at a ledger are a scan of the issuer's whole line history, and "what changed for this token
    between two ledgers" is no key range at all.
- **Everything the platform derives is in ClickHouse.** All 85 tables of a network database are there, derived ones included (`token_lines`, `tokens`,
  `mpt_holders`, the rollups, the state history), and `ClickHouseService` is the only database client.
  - The brief for this feature asked for derived tables in Postgres, with ClickHouse holding only raw transactions and metadata. That is not this
    system, and `data-model.md` and the migrations agree on it.
  - The owner chose ClickHouse, with this record making the case (2026-11-08).
- **The history is large.** Full XRPL history holds an estimated 1 to 3.5 billion changes of counting lines (10 to 31 a ledger over ~108 million ledgers).
- **The ingest and the aggregator have no room.** The ingest writes 40 tables per ledger. The aggregator's 30 s tick gives the jobs before `stats_live` 27 s
  already.
- **History arrives late and in pieces.** A deployment runs its syncer at the head and fills the history with `range-ingest`, which is node-bound and takes days to
  weeks for XRPL. The state tables change under anything built on them until that fill is done, and while the fill runs the stored ledgers have a gap that the
  coverage rule of the other features ignores.
- **Exactness rules out the shortcuts.** No sampling, no HyperLogLog, and no Float64 sums. D6's `sumOf` falls back to them when an amount does not fit `Decimal256(30)`; issued amounts run from 1e-81 to 1e96.

## Decision

1. **The token history lives in ClickHouse, in each network's database**, as seven tables of migration 019, none of them a ledger table.
   - `token_holder_changes`: the change log, ordered by token then ledger.
   - `token_checkpoints` and `token_checkpoint_heads`.
   - `token_hourly` and `token_hourly_dex`.
   - `token_history_state` and `token_history_dirty`.
2. **The change log is derived from the state history, not from the metadata.** A change is a state row of `trust_line_states` or `mpt_holder_states` seen
   from the token's side by the shared rule (`countsFor`, `orientations`), with the state before it. There is no second parser of `AffectedNodes`, no new ledger
   table and no parser version, so the history needs no reprocess.
3. **Holders at a ledger are a checkpoint plus changes.**
   - A token gets a checkpoint (its full set of counting lines) once its changes since the last one reach `max(its trust lines, 50,000)`.
   - Holders at N are the newest checkpoint at or before N, folded with the token's changes after it: a key range bounded by about `2 × max(lines, 50,000)` rows,
     whether N is the head or the first ledger.
   - The rule is a function of the history, so a rebuild writes the same checkpoints, and checkpoints never hold more rows than the change log.
4. **Series are hourly.** A row per token and UTC hour with activity holds the levels at the hour's end and the hour's flows. Days are summed from hours on read,
   ledger points are read from the change log, and a rolling 24 h, 7 d or 30 d window is whole hours plus two edge hours of changes, so every window is exact.
5. **A syncer worker of its own, `token_history`, follows the head.**
   - It has its own 1 s loop and lease, follows the commit marker through `state_touches` and `mpt_touches`, and writes a few small rows per ledger.
   - It repairs after a re-ingest, catches a finished build's levels up to the head and promotes it.
   - The ingest and the aggregator's jobs are unchanged; the aggregator gains one `agg_dirty` hook that only appends a range for the worker to repair.
   - `through_ledger` and `levels_through` in a generation's state row are the token history's commit marker.
6. **The build is an operator command, `token-history-build`, never the worker's.**
   - It is the one-off heavy work of a generation: the pass over the state history, the levels, the DEX history. It runs as `INSERT … SELECT` in ClickHouse with a
     thread cap the operator can set.
   - It refuses to start, and stops, while a `range-ingest` runs. It resumes where it stopped.
   - The worker only reports that a build is due (a gauge, a log line, and the `complete: false` its answers keep), for one of four reasons: no generation yet, the
     coverage has grown, the config changed, or a repair met an older parser.
7. **Generations, as D6's, on an unbroken history.**
   - A build runs beside the live generation, is promoted whole, and the old one is dropped by partition.
   - A generation's coverage starts at the first ledger of the newest unbroken run of stored ledgers that reaches the head. Unlike the other features, it never
     reaches across a gap, because levels are added up ledger by ledger and a missing ledger would falsify every figure after it.
8. **Sums are exact or not served.** SQL sums use `Decimal256(30)` where every amount fits. A sum holding one that does not is redone over the same bounded rows in
   BigNumber, never as a Float64. This is a deliberate departure from `sumOf` for this feature only.

## Consequences

**Positive**
- **No node and no reprocess for the history.** The build reads tables the index already holds: one pass over `trust_line_states`, one over the change log, one
  scan of `exchanges`. The build resumes from cursors in its state rows, an estimated half a day to two days for full XRPL history, against weeks for a node-bound reprocess.
- **The same query at the same ledger gives the same answer**, at the head and in 2014, and every read starts from a key prefix with a pinned bound.
- **The answers trail the head by a ledger and a pass**, seconds, instead of D6's minute. D6's `/holders` moves to the new tables once they are built.
- One database to run, back up and reason about. The derived tables sit beside the state tables they are made from, and a build is a server-side `INSERT … SELECT`, not
  a copy of billions of rows across a network.

**Negative / trade-offs**
- **Disk:** an estimated 70 to 350 GB per XRPL database, a second ordering of the state history, doubled while a rebuild runs beside the live generation.
  The first PR measures it.
- **A build shares the server.** The ingest never waits for `token-history-build`, but for the half a day to two days it runs on XRPL (estimated) it reads
  hundreds of GB and writes tens to hundreds. The ingest's inserts and the api's reads compete with it for ClickHouse's disk and CPU. It runs only when the
  operator starts it (off-peak, with fewer threads, stopped and resumed).
- **A step for the operator.** A build is due after the first deploy, after the history fill, after a config change, and after a repair that met an older parser.
  Until it runs, the answers stay those of the last generation, with its coverage, or 404 before the first. There is one more worker to operate (a lease, two alerts:
  lag and errors) and one more command in the runbook. The syncer's ClickHouse user needs `ALTER DELETE` on the four generation tables.
- **Eventual after a re-ingest**, like every aggregate (ADR-0008): between a rewrite and its repair the token history shows the old data. Reproducibility
  holds except across the repair of a ledger at or below the one asked.
- **Complete only after the history fill and a build on it.** Until the state tables reach ledger 32,570 (ADR-0015) and the command has run after the fill, a line
  untouched since the coverage start is missing.
- **Retention.** The token history is not dropped with a ledger block, and a rebuild after a dropped block is exact only for lines with a state row above it, as
  for D6's tables.

**Rejected**
- **Postgres for the derived tables** (the brief's suggestion). The change log would be a copy of billions of rows streamed out of ClickHouse at the first build and
  at every rebuild. Its reads are range scans and grouped sums, which favour a columnar store. And it would add a database to deploy, replicate, back up and migrate per
  network for one feature, with no shared transaction with the ledger tables to gain.
- **Writing the change log in the ingest.** The trust-line walk could emit it with the before-state from `PreviousFields`. That costs a parser version, a reprocess of ~108
  million ledgers from a node for the history, and an aggregator job that has no room in the tick.
- **Periodic full snapshots without a change log.** A snapshot between two of them still scans an issuer's history, and daily sets cost lines × days, tens of
  billions of rows.
- **Deltas only, without checkpoints.** A snapshot of an old, busy token would read its whole history.
- **Holder counts by HyperLogLog, or sums by Float64.** Not exact.
