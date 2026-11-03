import { networkLine } from './pdf-file';

describe('the network line of the PDF header', () => {
  it('names the network by its display name', () =>
    expect(['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet', 'other'].map(networkLine)).toEqual([
      'Network: XRP Ledger',
      'Network: Xahau',
      'Network: XRPL Testnet',
      'Network: Xahau Testnet',
      'Network: other',
    ]));

  it('does not take the name of an object property for a network', () =>
    expect(networkLine('constructor')).toBe('Network: constructor'));
});
