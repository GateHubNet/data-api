import { createHash } from 'crypto';
import { AMENDMENTS_OBJECT_INDEX, FEE_SETTINGS_OBJECT_INDEX, NEGATIVE_UNL_OBJECT_INDEX } from './ledger-objects';

/** The index of a singleton ledger object: SHA-512Half of its 16-bit space key (`f`, `N`, `e`). */
const singletonIndex = (space: string): string =>
  createHash('sha512')
    .update(Buffer.from([0, space.charCodeAt(0)]))
    .digest()
    .subarray(0, 32)
    .toString('hex')
    .toUpperCase();

describe('ledger object indexes (F11)', () => {
  it('are the keylets of the Amendments, NegativeUNL and FeeSettings singletons', () => {
    expect(AMENDMENTS_OBJECT_INDEX).toBe(singletonIndex('f'));
    expect(NEGATIVE_UNL_OBJECT_INDEX).toBe(singletonIndex('N'));
    expect(FEE_SETTINGS_OBJECT_INDEX).toBe(singletonIndex('e'));
  });

  it('are the values the spec names', () => {
    expect(AMENDMENTS_OBJECT_INDEX).toBe('7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4');
    expect(NEGATIVE_UNL_OBJECT_INDEX).toBe('2E8A59AA9D3B5B186B0B9E0F62E6C02587CA74A4D778938E957B6357D364B244');
    expect(FEE_SETTINGS_OBJECT_INDEX).toBe('4BC50C9B0D8515D3EAAE1E74B29A95804346C491EE1A95BF25E4AAB854A6A651');
  });
});
