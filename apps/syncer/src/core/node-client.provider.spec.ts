import { getNetworkProfile, NodeClient, NodeClientOptions } from '@gatehub/data-api-shared';
import { SyncerConfig } from '../config/syncer.config';
import { createNodeClient } from './node-client.provider';

function fakeClient(networkId: number | undefined) {
  const calls: string[] = [];
  const client = {
    start: jest.fn(async () => {
      calls.push('start');
    }),
    serverInfo: jest.fn(async () => {
      calls.push('serverInfo');
      return { complete_ledgers: '1-2', network_id: networkId };
    }),
    stop: jest.fn(async () => {
      calls.push('stop');
    }),
  };
  return { client, calls };
}

const cfg = (nodeEndpoints: string) => ({ nodeEndpoints }) as SyncerConfig;

describe('createNodeClient', () => {
  it('builds the client from the comma separated endpoints, starts it and checks the network', async () => {
    const { client, calls } = fakeClient(undefined);
    let options: NodeClientOptions | undefined;
    const result = await createNodeClient(
      cfg(' wss://a.example , ws://b.example:6006,'),
      getNetworkProfile('xrpl'),
      (opts) => {
        options = opts;
        return client as unknown as NodeClient;
      },
    );
    expect(result).toBe(client);
    expect(options?.endpoints).toEqual(['wss://a.example', 'ws://b.example:6006']);
    expect(calls).toEqual(['start', 'serverInfo']);
    expect(client.stop).not.toHaveBeenCalled();
  });

  it('accepts the Xahau network ids for GH_NETWORK=xahau', async () => {
    const { client } = fakeClient(21337);
    await expect(
      createNodeClient(cfg('wss://xahau.network'), getNetworkProfile('xahau'), () => client as unknown as NodeClient),
    ).resolves.toBe(client);
  });

  it('stops the client and fails when the node belongs to another network', async () => {
    const { client, calls } = fakeClient(21337);
    await expect(
      createNodeClient(cfg('wss://xahau.network'), getNetworkProfile('xrpl'), () => client as unknown as NodeClient),
    ).rejects.toThrow('Node network_id 21337 does not match GH_NETWORK=xrpl');
    expect(calls).toEqual(['start', 'serverInfo', 'stop']);
  });

  it('stops the client and rethrows when server_info fails', async () => {
    const { client } = fakeClient(0);
    client.serverInfo.mockRejectedValue(new Error('timeout'));
    await expect(
      createNodeClient(cfg('wss://a.example'), getNetworkProfile('xrpl'), () => client as unknown as NodeClient),
    ).rejects.toThrow('timeout');
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it('lets the NodeClient reject an invalid endpoint', async () => {
    await expect(createNodeClient(cfg('http://a.example'), getNetworkProfile('xrpl'))).rejects.toThrow(
      'Invalid node endpoint',
    );
  });
});
