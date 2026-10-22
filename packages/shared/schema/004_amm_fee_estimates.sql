-- =============================================================================
-- GateHub Data API: the 24 h fee estimates of the AMM volume (D2b.3). Additive to 001_baseline.sql, one database per network.
--
-- One column of volume_live, fees_est_f: on the component rows of the amm_volume set of the period day, the estimated
-- fees each pool charged on the swaps of the window, in the native currency. It is NULL when they are not known (a swap
-- with no known fee, Ruling R-A26 of the AMM work), on the sentinel and on every row of the other sets. The aggregator
-- writes it in the set's one insert, so a set written before this migration reads as not known until the next tick.
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

ALTER TABLE volume_live ADD COLUMN IF NOT EXISTS fees_est_f Nullable(Float64);
