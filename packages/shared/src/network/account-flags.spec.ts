import { accountFlagsOf } from './account-flags';
import { getNetworkProfile } from './network-profile';

describe('accountFlagsOf', () => {
  it("reads XRPL Testnet's flags from its own definitions file", () => {
    const flags = accountFlagsOf(getNetworkProfile('xrpl-testnet'));
    expect(flags).toEqual(
      expect.arrayContaining([
        { name: 'DefaultRipple', bit: 0x00800000 },
        { name: 'AllowTrustLineClawback', bit: 0x80000000 },
      ]),
    );
    expect(flags.map((f) => f.bit)).toEqual([...flags.map((f) => f.bit)].sort((a, b) => a - b));
  });

  it('gives Xahau Testnet the hand list of Xahau', () => {
    expect(accountFlagsOf(getNetworkProfile('xahau-testnet'))).toEqual(accountFlagsOf(getNetworkProfile('xahau')));
    expect(accountFlagsOf(getNetworkProfile('xahau-testnet'))).toContainEqual({
      name: 'DisallowIncomingRemit',
      bit: 0x80000000,
    });
  });

  it('keeps one cached list per network name', () => {
    expect(accountFlagsOf(getNetworkProfile('xrpl-testnet'))).toBe(accountFlagsOf(getNetworkProfile('xrpl-testnet')));
    expect(accountFlagsOf(getNetworkProfile('xrpl-testnet'))).not.toBe(accountFlagsOf(getNetworkProfile('xrpl')));
  });
});
