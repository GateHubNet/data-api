import { DomainTomlsRow, EMPTY_TOML_CONTENT, okTomlRow, TomlContent } from '@gatehub/data-api-shared';
import { DOMAIN_VERIFIED_GRACE_S, isTransientReason } from '../validators/domain-checker';
import { FetchFailure } from '../validators/safe-fetch';

/** A transient failure is checked again after an hour. */
export const TOML_TRANSIENT_RECHECK_S = 3_600;
/** A definite failure is checked again after a day, then twice as long after each one in a row, up to this: 7 days. */
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
 * - **a transient failure** (`isTransientReason`): the next check after an hour. The content and `fetched_at` of `prev` stay
 *   while `prev` was fetched at most 24 h ago, so that a website that blips keeps its names; otherwise the content is empty
 *   and `fetched_at` null.
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

  const carried = prev !== undefined && prev.fetched_at !== null && now - prev.fetched_at <= DOMAIN_VERIFIED_GRACE_S;
  return {
    ...failed,
    fetched_at: carried ? prev.fetched_at : null,
    next_check_at: after(TOML_TRANSIENT_RECHECK_S),
    ...(carried ? contentOf(prev) : EMPTY_TOML_CONTENT),
  };
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
