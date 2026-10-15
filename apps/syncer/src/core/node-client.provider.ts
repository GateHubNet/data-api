import { assertNetwork, NetworkProfile, NodeClient, NodeClientOptions } from '@gatehub/data-api-shared';
import { endpointList, SyncerConfig } from '../config/syncer.config';

/**
 * Builds the process-wide NodeClient from `GH_NODE_ENDPOINTS`, connects it, and refuses a node of another network.
 *
 * It is the factory of an async provider, so the client is started and checked before any module's lifecycle hook runs:
 * a worker never sees a client that is not connected yet. A client that fails the network check is stopped again.
 */
export async function createNodeClient(
  cfg: Pick<SyncerConfig, 'nodeEndpoints'>,
  profile: NetworkProfile,
  make: (opts: NodeClientOptions) => NodeClient = (opts) => new NodeClient(opts),
): Promise<NodeClient> {
  const client = make({ endpoints: endpointList(cfg.nodeEndpoints) });
  try {
    await client.start();
    assertNetwork(await client.serverInfo(), profile);
  } catch (err) {
    await client.stop();
    throw err;
  }
  return client;
}
