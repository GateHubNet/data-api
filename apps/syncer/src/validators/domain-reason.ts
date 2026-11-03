/** A domain that was verified keeps `verified` through a transient failure for this long after the last success. */
export const DOMAIN_VERIFIED_GRACE_S = 86_400;

/** Why a domain is not verified (`''` when it is). The fetch failures are those of the safe fetcher. */
export type DomainReason =
  | ''
  | 'not_listed'
  | 'toml_invalid'
  | 'too_large'
  | 'redirect_rejected'
  | 'blocked_address'
  | 'domain_invalid'
  | 'manifest_unverified'
  | 'http_status'
  | 'dns_error'
  | 'connect_error'
  | 'tls_error'
  | 'timeout';

/**
 * Whether a failure may pass by itself (a website that blips) and so is checked again soon and does not take the badge from
 * a domain that was verified a moment ago: the network failures, a 5xx and a 429. A 4xx, a file that is not what it should
 * be, and every other reason are definite.
 */
export function isTransientReason(reason: DomainReason, statusCode?: number): boolean {
  if (reason === 'dns_error' || reason === 'connect_error' || reason === 'tls_error' || reason === 'timeout')
    return true;
  return reason === 'http_status' && statusCode !== undefined && (statusCode >= 500 || statusCode === 429);
}
