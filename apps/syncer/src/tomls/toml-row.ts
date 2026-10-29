import { DomainTomlsRow, EMPTY_TOML_CONTENT, okTomlRow, TomlContent } from '@gatehub/data-api-shared';
import { DOMAIN_VERIFIED_GRACE_S, isTransientReason } from '../validators/domain-checker';
import { FetchFailure } from '../validators/safe-fetch';

/** A transient failure that carries the content is checked again after an hour. */
export const TOML_TRANSIENT_RECHECK_S = 3_600;
/**
 * A failure that carries no content is checked again after a day, then twice as long after each one in a row, up to this:
 * 7 days.
 */
export const TOML_BACKOFF_MAX_S = 604_800;
const TOML_BACKOFF_FIRST_S = 86_400;
/** The most `failures` counts: the column holds a UInt16. */
const TOML_FAILURES_MAX = 65_535;

/** Why a check of a domain's toml failed: the safe fetcher's reasons, or a file that arrived and is not TOML. */
export type TomlFailure = FetchFailure | 'toml_invalid';

/** What one check of a domain's toml came to: the content of a file that was read, or why it was not. */
export type TomlCheck = { domain: string; tomlUrl: string } & (
  | { content: TomlContent }
  | { reason: TomlFailure; statusCode?: number }
);

/**
 * The row to store for a check (spec 4.4). `prev` is the newest stored row of the domain, `now` unix seconds (with the
 * milliseconds as a fraction). `next_check_at` is a whole second.
 *
 * - **read as TOML**: `okTomlRow`, the row `recordToml` writes: the content, fetched now, no failures, the next check after
 *   `recheckMs`.
 * - **a transient failure** (`isTransientReason`): the content and `fetched_at` of `prev` stay while `prev` was fetched at
 *   most `recheckMs` and 24 h ago (`DOMAIN_VERIFIED_GRACE_S`): the grace runs from the re-read the failure missed, so that a
 *   website that blips at its daily re-read keeps its names. While the content stays, the next check is after an hour. Once
 *   it is gone (the content is empty and `fetched_at` null), the failure backs off as a definite one does, counted from the
 *   first failure that carried nothing: 1, 2, 4, then 7 days (`waitWithoutContent`), so that a dead host is not asked
 *   every hour for ever.
 * - **a definite failure** (anything else, `toml_invalid` too): empty content, `fetched_at` null, the next check after 1, 2,
 *   4, then 7 days of failures in a row.
 *
 * `failures` counts the failed checks in a row (up to 65,535, the most its column holds), 0 exactly when the newest row is `ok`.
 */
export function nextTomlRow(
  prev: DomainTomlsRow | undefined,
  check: TomlCheck,
  now: number,
  recheckMs: number,
): DomainTomlsRow {
  if ('content' in check) {
    return okTomlRow({ domain: check.domain, tomlUrl: check.tomlUrl, content: check.content, now, recheckMs });
  }

  // the column is a UInt16: 65,536 would wrap to 0, which reads as ok (`failures` is 0 exactly when the newest row is `ok`)
  const failures = Math.min((prev?.failures ?? 0) + 1, TOML_FAILURES_MAX);
  // a whole second: `next_check_at` is a `DateTime`
  const after = (seconds: number) => Math.ceil(now + seconds);
  const failed = {
    domain: check.domain.toLowerCase(),
    toml_url: check.tomlUrl,
    status: 'failed',
    reason: check.reason,
    status_code: check.reason === 'http_status' ? (check.statusCode ?? 0) : 0,
    checked_at: now,
    failures,
  } as const;

  if (!isTransientReason(check.reason, check.statusCode)) {
    return {
      ...failed,
      fetched_at: null,
      next_check_at: after(Math.min(TOML_BACKOFF_FIRST_S * 2 ** (failures - 1), TOML_BACKOFF_MAX_S)),
      ...EMPTY_TOML_CONTENT,
    };
  }

  const carried =
    prev !== undefined &&
    prev.fetched_at !== null &&
    now - prev.fetched_at <= recheckMs / 1000 + DOMAIN_VERIFIED_GRACE_S;
  if (carried) {
    return {
      ...failed,
      fetched_at: prev.fetched_at,
      next_check_at: after(TOML_TRANSIENT_RECHECK_S),
      ...contentOf(prev),
    };
  }
  return { ...failed, fetched_at: null, next_check_at: after(waitWithoutContent(prev)), ...EMPTY_TOML_CONTENT };
}

/**
 * The wait of a transient failure that carries no content, in seconds: a day after a row that held content (an `ok` one, or a
 * failure that carried it) or after none, else twice the days the row before waited (its `next_check_at` after its
 * `checked_at`, rounded: the whole second of `next_check_at` adds less than one), at least one and at most 7. A run of such
 * failures, whatever their reasons, so waits 1, 2, 4, then 7 days, as definite failures do; the row before tells which step it
 * was, as `failures` cannot (it counts the hourly checks that carried the content too).
 */
function waitWithoutContent(prev: DomainTomlsRow | undefined): number {
  if (prev === undefined || prev.status !== 'failed' || prev.fetched_at !== null) return TOML_BACKOFF_FIRST_S;
  const waitedDays = Math.round((prev.next_check_at - prev.checked_at) / TOML_BACKOFF_FIRST_S);
  return Math.min(Math.max(2 * waitedDays, 1) * TOML_BACKOFF_FIRST_S, TOML_BACKOFF_MAX_S);
}

/** The content of a stored row, with lists of its own. */
function contentOf(row: DomainTomlsRow): TomlContent {
  return {
    modified: row.modified,
    expires: row.expires,
    accounts: [...row.accounts],
    currencies: [...row.currencies],
    validators: [...row.validators],
    principals: [...row.principals],
  };
}
