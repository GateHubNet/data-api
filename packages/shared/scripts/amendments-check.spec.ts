import { getNetworkProfile, networkChoiceText } from '../src/network';
import { AMENDMENTS_OBJECT_INDEX } from '../src/validators/ledger-objects';
import { askNode, parseArgs } from './amendments-check';

/** A node that answers `server_info` with `networkId`, `feature` with one amendment and the Amendments object with one ID. */
function node(networkId: number | undefined) {
  return {
    serverInfo: jest.fn(async () => ({
      complete_ledgers: '1-100',
      ...(networkId === undefined ? {} : { network_id: networkId }),
    })),
    request: jest.fn(async (command: Record<string, unknown>) =>
      command.command === 'feature'
        ? { features: { ['AA'.repeat(32)]: { name: 'TestVoting' } } }
        : { node: { Amendments: ['BB'.repeat(32)] } },
    ),
  };
}

describe('amendments-check: what the node says', () => {
  it('refuses a node of another network before it asks anything: a Xahau node for the XRPL file', async () => {
    const xahau = node(21337);
    await expect(askNode(getNetworkProfile('xrpl'), xahau as never)).rejects.toThrow(
      'Node network_id 21337 does not match GH_NETWORK=xrpl',
    );
    expect(xahau.request).not.toHaveBeenCalled();
  });

  it('refuses an XRPL node for the Xahau file', async () => {
    const xrpl = node(undefined);
    await expect(askNode(getNetworkProfile('xahau'), xrpl as never)).rejects.toThrow('does not match GH_NETWORK=xahau');
    expect(xrpl.request).not.toHaveBeenCalled();
  });

  it('asks a node of the network for feature and for the Amendments object of the validated ledger', async () => {
    const xahau = node(21337);
    await expect(askNode(getNetworkProfile('xahau'), xahau as never)).resolves.toEqual({
      nodeFeatures: [{ id: 'AA'.repeat(32), name: 'TestVoting' }],
      ledgerIds: ['BB'.repeat(32)],
    });
    expect(xahau.request.mock.calls.map(([command]) => command)).toEqual([
      { command: 'feature' },
      { command: 'ledger_entry', index: AMENDMENTS_OBJECT_INDEX, ledger_index: 'validated' },
    ]);
  });
});

describe('amendments-check: the command line', () => {
  let exit: jest.SpyInstance;
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    // usage() exits with status 2; the throw stops parseArgs where the exit would
    exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    exit.mockRestore();
    consoleError.mockRestore();
  });

  it('takes a testnet with its default endpoint', () =>
    expect(parseArgs(['--network', 'xahau-testnet'])).toEqual({
      network: 'xahau-testnet',
      endpoint: 'wss://xahau-test.net',
      clickhouse: false,
    }));

  it('takes each of the four networks', () =>
    expect(
      ['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet'].map((network) => parseArgs(['--network', network]).network),
    ).toEqual(['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet']));

  it('refuses another network with exit 2', () => {
    expect(() => parseArgs(['--network', 'bitcoin'])).toThrow('exit 2');
    expect(exit).toHaveBeenCalledWith(2);
    expect(consoleError.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(networkChoiceText('--network'));
  });
});
