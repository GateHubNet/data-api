import { getNetworkProfile, NodeClient, NodeClientOptions, NodeThrottledError } from '@gatehub/data-api-shared';
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

  describe('the boot network check retries (ruling R99)', () => {
    const quiet = () => ({
      warns: [] as string[],
      warn(message: string) {
        this.warns.push(message);
      },
    });

    it('retries server_info with a growing backoff until the node answers', async () => {
      const { client } = fakeClient(0);
      client.serverInfo
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({ complete_ledgers: '1-2', network_id: 0 });
      const waits: number[] = [];
      const logger = quiet();
      const result = await createNodeClient(
        cfg('wss://a.example'),
        getNetworkProfile('xrpl'),
        () => client as unknown as NodeClient,
        { logger, sleep: async (ms) => void waits.push(ms), backoffInitialMs: 100, backoffMaxMs: 150 },
      );
      expect(result).toBe(client);
      expect(client.serverInfo).toHaveBeenCalledTimes(3);
      expect(waits).toEqual([100, 150]);
      expect(client.stop).not.toHaveBeenCalled();
      expect(logger.warns).toHaveLength(2);
      expect(logger.warns[0]).toMatch(/network check.*timeout.*retry in 0\.1 s/i);
    });

    it('waits as long as a rate-limited node asks before it asks again', async () => {
      const { client } = fakeClient(0);
      client.serverInfo
        .mockRejectedValueOnce(new NodeThrottledError(['wss://a.example'], 12_376, 'rate limit: retry in ~12126ms'))
        .mockResolvedValue({ complete_ledgers: '1-2', network_id: 0 });
      const waits: number[] = [];
      await createNodeClient(cfg('wss://a.example'), getNetworkProfile('xrpl'), () => client as unknown as NodeClient, {
        logger: quiet(),
        sleep: async (ms) => void waits.push(ms),
        backoffInitialMs: 100,
      });
      expect(waits).toEqual([12_376]);
    });

    it('does not retry a node of another network: that is a wrong configuration', async () => {
      const { client } = fakeClient(21337);
      const sleep = jest.fn(async () => undefined);
      await expect(
        createNodeClient(cfg('wss://xahau.network'), getNetworkProfile('xrpl'), () => client as unknown as NodeClient, {
          logger: quiet(),
          sleep,
        }),
      ).rejects.toThrow('Node network_id 21337 does not match GH_NETWORK=xrpl');
      expect(sleep).not.toHaveBeenCalled();
      expect(client.stop).toHaveBeenCalledTimes(1);
    });
  });

  it('lets the NodeClient reject an invalid endpoint', async () => {
    await expect(createNodeClient(cfg('http://a.example'), getNetworkProfile('xrpl'))).rejects.toThrow(
      'Invalid node endpoint',
    );
  });
});
