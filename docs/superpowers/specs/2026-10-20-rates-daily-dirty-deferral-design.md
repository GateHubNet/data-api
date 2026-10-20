# `rates_daily` defers the days of pending `agg_dirty` ranges: design note

Date: 2026-10-20. Status: implemented, for the owner to review (a follow-up of D2, `2026-10-19-account-market-aggregates-design.md`, parked by its final review
as Ruling F4). It changes one rule of D2 section 3.1 (the order of work of `rates_daily`) and nothing else.

## The problem

A `range-ingest` (or `--reprocess`) writes history a chunk at a time (1,000 ledgers, about an hour of XRPL) and marks each chunk in
`agg_dirty` right after writing it. `stats_dirty` drains the queue in slices, and the `rates_daily` hook of each slice that touches
days X..Y marks the valid days X..Y+14 stale (a day's rate reads the trades of the 14 days before it). `rates_daily` then computes the
stale days again, newest first, in the same tick.

A day of ledgers is about 24 chunks. When the re-ingest is faster than `stats_dirty` drains, the queue holds the chunks of the days
ahead of the drain, and each of them, once drained, marks the days its window reaches again. So `rates_daily` keeps computing days
X..X+14 that the next drained chunk of day X (or X+1, ...) makes stale once more: up to 24 times per day of history for each of 15
days, each 0.5 to 3 s, all of it inside its 8 s budget, and all of it thrown away. Nothing is wrong (a stale day is valued on read),
but the budget goes to work that cannot last while the days the re-ingest has already passed wait.

## The rule

At each run, after it lists the due days (closed, final, without a valid set), `rates_daily` reads the days the pending ranges of
`agg_dirty` touch and **defers every due day whose 15-day window (D − 14 .. D) meets one of them**, that is the days X..Y+14 of each
pending range of days X..Y: the days its hook will mark once the range is drained. A deferred day is not computed this run.

- **Correctness is unchanged.** A deferred day is a day without a valid set, which the readers value on read, as they do now. The
  rule only chooses which due days a run works on.
- **Nothing is lost.** A deferred day stays due. Once the range is drained (its hook marks nothing new: the day is stale already) and
  no other pending range reaches it, the next run computes it, newest first, as today. A range is deleted from `agg_dirty` only after
  its slices and hooks succeeded, so a day is never left waiting for a range that is gone.
- **What it saves.** With a backlog, the days behind the drain are computed once, and the days ahead of it wait for their last mark.
  When `stats_dirty` keeps up (the queue is empty by the time `rates_daily` runs: it is job 9, after `stats_dirty`, job 7), nothing
  is deferred and the job behaves as today: the waste is then bounded by the speed of the re-ingest, one chunk's marks at a time.
- **The cost** is one small read per run that has a due day: the distinct (first day, last day) pairs of the ranges of `agg_dirty`
  (a range marked twice has one span), about one row per day of the backlog. A run with nothing due reads nothing more than today.
- **A range that keeps failing** (a hook or a slice that fails at every tick) defers its days for as long as it fails. They stay in
  `syncer_rates_daily_missing_days` (deferred days are missing days), so the "Daily rates not written" alert (above 2 for 6 hours)
  covers them, as `syncer_aggregator_errors_total` covers the failing range.
- **The gauge and the log.** `syncer_rates_daily_missing_days` keeps counting deferred days. The back-fill is not "done" while a day
  is deferred (as while one waits after a failure). A run that defers days says so at debug level, with how many and the span.
- **At least one day per run** stays the rule for the days that are not deferred; a run whose due days are all deferred computes none
  (computing one of them would be the waste the rule is for).

## What changes

- `apps/syncer/src/aggregator/agg-dirty.ts`: `dirtyDaySpans(ch)`, the distinct (first day, last day) of the pending ranges (a range
  `[from, to)` covers the days of `from` to `to − 1 s`), oldest first.
- `aggregate-job-deps.ts`: `dirtyDaySpans` joins `AggregateFunctions`, so the runner's tests replace it.
- `rates-daily.job-runner.ts`: the deferral in `refresh` (`deferredDays`), before the sweep, and the back-fill's "done" waits for no
  deferred day.
- Tests: the runner spec (deferral, catch-up once drained, all deferred, no read when nothing is due), the `agg_dirty` SQL e2e
  (`dirtyDaySpans` against ClickHouse), and the schedule spec's fake answers no span.
- Docs: the order of work of `rates_daily` in `docs/syncer.md` (7.1 and 7.6) and the re-ingest paragraph of `docs/operations.md`.

## Not chosen

- **Deferring days that a range drained in the last few minutes** (expecting more chunks of the same days) would also catch a
  re-ingest that `stats_dirty` keeps up with, but it guesses at what the ingest will do, delays every small repair by that window,
  and needs state shared between the hook and the job. The pending queue is a fact, not a guess.
- **Reading `ingest_log` for an open run** says that a chunk is being written, not which days the run will write next.
