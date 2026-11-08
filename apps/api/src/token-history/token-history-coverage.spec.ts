import { getNetworkProfile } from '@gatehub/data-api-shared';
import { tokenHistoryCoverage } from './token-history-coverage';

const XRPL = getNetworkProfile('xrpl');
const live = (coverage_from: number) => ({ generation: 1, through: 100_000_000, close_time: 0, coverage_from });

describe('tokenHistoryCoverage', () => {
  it('coverage is complete from the first ledger and false above it', () => {
    const first = XRPL.firstLedger!;
    expect(tokenHistoryCoverage(live(first), XRPL, undefined, 'issued')).toEqual({
      from_ledger_index: first,
      complete: true,
    });
    expect(tokenHistoryCoverage(live(first + 1), XRPL, undefined, 'issued')).toEqual({
      from_ledger_index: first + 1,
      complete: false,
    });
  });

  it('MPT coverage is complete from the MPTokensV1 ledger', () => {
    expect(tokenHistoryCoverage(live(99_226_369), XRPL, 99_226_369, 'mpt')).toEqual({
      from_ledger_index: 99_226_369,
      complete: true,
    });
    expect(tokenHistoryCoverage(live(99_226_370), XRPL, 99_226_369, 'mpt').complete).toBe(false);
    // no enable ledger known: never complete
    expect(tokenHistoryCoverage(live(1), XRPL, undefined, 'mpt').complete).toBe(false);
  });

  it('a network without a first ledger is never complete for issued tokens', () => {
    const testnet = getNetworkProfile('xrpl-testnet');
    expect(tokenHistoryCoverage(live(1), { ...testnet, firstLedger: undefined }, undefined, 'issued').complete).toBe(
      false,
    );
  });
});
