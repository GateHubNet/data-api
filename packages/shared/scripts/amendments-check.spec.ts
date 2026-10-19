import { getNetworkProfile } from '../src/network';
import { AMENDMENTS_OBJECT_INDEX } from '../src/validators/ledger-objects';
import { askNode } from './amendments-check';

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
