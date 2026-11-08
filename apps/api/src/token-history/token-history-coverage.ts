import { NetworkProfile } from '@gatehub/data-api-shared';
import { Coverage } from '../common/feature-coverage.service';
import { LiveTokenHistory } from './token-history-ledger';

/**
 * The `coverage` of a token history answer (spec 6): the live generation's `coverage_from`, not the ledgers of the request time.
 * It is complete for an issued token when it is at or before the network's first ledger (none on a testnet), and for an MPT when it
 * is at or before the ledger `MPTokensV1` was enabled in (`mptStart`; none known is incomplete).
 */
export function tokenHistoryCoverage(
  live: Pick<LiveTokenHistory, 'coverage_from'>,
  profile: Pick<NetworkProfile, 'firstLedger'>,
  mptStart: number | undefined,
  kind: 'issued' | 'mpt',
): Coverage {
  const start = kind === 'issued' ? profile.firstLedger : mptStart;
  return { from_ledger_index: live.coverage_from, complete: start !== undefined && live.coverage_from <= start };
}
