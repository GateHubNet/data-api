import { getNetworkProfile, NetworkName } from '../network/network-profile';
import { countsOn } from './counts-on';

describe('countsOn', () => {
  const counts = (network: NetworkName, entryNetwork: string): boolean =>
    countsOn(entryNetwork, getNetworkProfile(network));

  it('xrpl counts an entry without a network, main and mainnet, and no other', () => {
    expect(['', 'main', 'mainnet'].map((n) => counts('xrpl', n))).toEqual([true, true, true]);
    expect(['testnet', '21337', 'xahau'].map((n) => counts('xrpl', n))).toEqual([false, false, false]);
  });

  it('xahau counts its id, its name, main and mainnet, and not testnet', () => {
    expect(['', '21337', 'xahau', 'main', 'mainnet'].map((n) => counts('xahau', n))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(counts('xahau', 'testnet')).toBe(false);
  });

  it('xrpl-testnet counts testnet and not main', () => {
    expect(counts('xrpl-testnet', 'testnet')).toBe(true);
    expect(counts('xrpl-testnet', 'main')).toBe(false);
  });

  it('xahau-testnet counts 21338 and testnet and not 21337', () => {
    expect(['21338', 'testnet'].map((n) => counts('xahau-testnet', n))).toEqual([true, true]);
    expect(counts('xahau-testnet', '21337')).toBe(false);
  });

  it('counts an entry without a network on every network', () =>
    expect((['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet'] as const).map((n) => counts(n, ''))).toEqual([
      true,
      true,
      true,
      true,
    ]));

  it('compares the text as the writer stored it: lower case, so MAINNET is another network', () =>
    expect(counts('xrpl', 'MAINNET')).toBe(false));
});
