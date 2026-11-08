/**
 * The values of the token history (issuer analytics, spec 2026-11-08-issuer-analytics-design.md). The config version names the
 * rules a generation was built with: a change to the token side, the checkpoint floor or the flow rules raises it, and the
 * worker then reports a build as due.
 */

/** The config of a generation (spec 2.5, 4.6). */
export const TOKEN_HISTORY_CONFIG_VERSION = 1;
/** A token gets a checkpoint once its changes since the last reach `max(trust lines, this)` (spec 4.3). */
export const TOKEN_HISTORY_CHECKPOINT_FLOOR = 50_000;
/** The accounts of one batch of the build's `changes` pass (spec 4.6). */
export const TOKEN_HISTORY_PASS_ACCOUNTS = 500;
/** `max_threads` of the build's statements, unless `--threads` says otherwise (spec 4.6). */
export const TOKEN_HISTORY_BUILD_THREADS = 4;
/** A token with more changes than this is built in ledger slices of this many changes (spec 4.6). */
export const TOKEN_HISTORY_LEVELS_SLICE = 5_000_000;
/** A finished build is promoted once its `levels_through` is within this many ledgers of its `through_ledger` (spec 4.6). */
export const TOKEN_HISTORY_PROMOTE_NEAR = 10;
/** A retired generation's partitions are dropped this long after it was retired (spec 4.6). */
export const TOKEN_HISTORY_RETIRED_KEEP_MS = 900_000;
/** The worker reads the commit marker this often (spec 4.1). */
export const TOKEN_HISTORY_POLL_MS = 1_000;
/** What a pass of the worker may spend (spec 4.1). */
export const TOKEN_HISTORY_PASS_BUDGET_MS = 1_000;
/** The worker checks whether a build is due this often (spec 4.6). */
export const TOKEN_HISTORY_CHECK_MS = 600_000;
/** The most addresses `exclude` takes (spec 5.0). */
export const TOKEN_HISTORY_EXCLUDE_MAX = 20;
/** The widest window of `/supply` with `interval=ledger`, in ledgers (spec 5.3). */
export const TOKEN_HISTORY_LEDGER_WINDOW_MAX = 100_000;
/** The widest window of `/flows`, in days (spec 5.6). */
export const TOKEN_HISTORY_FLOWS_MAX_DAYS = 366;
/** The widest window of `/flows` with `interval=hour`, in days (spec 5.6). */
export const TOKEN_HISTORY_FLOWS_HOURLY_MAX_DAYS = 31;
