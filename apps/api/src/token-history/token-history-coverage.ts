import { NetworkProfile } from '@gatehub/data-api-shared';
import { Coverage } from '../common/feature-coverage.service';
import { LiveTokenHistory } from './token-history-ledger';

/**
 * The `coverage` of a token history answer (spec 6): the live generation's `coverage_from`, not the ledgers of the request time.
 * It is complete for an issued token when it is at or before the network's first ledger (none on a testnet), and for an MPT when it
 * is at or before the ledger `MPTokensV1` was enabled in (`mptStart`; none known is incomplete) and so is the start of the ledgers
 * that parser 10 wrote (`mptFrom`, the feature `mpt`'s coverage: an older parser recorded no MPT state), which is then the start.
 */
export function tokenHistoryCoverage(
  live: Pick<LiveTokenHistory, 'coverage_from'>,
  profile: Pick<NetworkProfile, 'firstLedger'>,
  mptStart: number | undefined,
  kind: 'issued' | 'mpt',
  mptFrom?: number,
): Coverage {
  if (kind === 'issued') {
    const first = profile.firstLedger;
    return { from_ledger_index: live.coverage_from, complete: first !== undefined && live.coverage_from <= first };
  }
  const from = Math.max(live.coverage_from, mptFrom ?? live.coverage_from);
  return { from_ledger_index: from, complete: mptStart !== undefined && mptFrom !== undefined && from <= mptStart };
}
