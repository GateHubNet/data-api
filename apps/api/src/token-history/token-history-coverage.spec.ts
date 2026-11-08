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
    expect(tokenHistoryCoverage(live(99_226_369), XRPL, 99_226_369, 'mpt', 1)).toEqual({
      from_ledger_index: 99_226_369,
      complete: true,
    });
    expect(tokenHistoryCoverage(live(99_226_370), XRPL, 99_226_369, 'mpt', 1).complete).toBe(false);
    // no enable ledger known: never complete
    expect(tokenHistoryCoverage(live(1), XRPL, undefined, 'mpt', 1).complete).toBe(false);
  });

  it('MPT coverage is incomplete while an older parser wrote a ledger above the MPTokensV1 ledger', () => {
    // parser 10's ledgers (the MPT states) start above the enable ledger: the MPT history before them is missing
    expect(tokenHistoryCoverage(live(99_226_369), XRPL, 99_226_369, 'mpt', 99_300_000)).toEqual({
      from_ledger_index: 99_300_000,
      complete: false,
    });
    expect(tokenHistoryCoverage(live(99_226_000), XRPL, 99_226_369, 'mpt', 99_200_000)).toEqual({
      from_ledger_index: 99_226_000,
      complete: true,
    });
    // issued tokens do not depend on it
    expect(tokenHistoryCoverage(live(32_570), XRPL, 99_226_369, 'issued', 99_300_000).complete).toBe(true);
  });

  it('a network without a first ledger is never complete for issued tokens', () => {
    const testnet = getNetworkProfile('xrpl-testnet');
    expect(tokenHistoryCoverage(live(1), { ...testnet, firstLedger: undefined }, undefined, 'issued').complete).toBe(
      false,
    );
  });
});
