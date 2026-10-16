import {
  assertNetwork,
  NetworkProfile,
  NodeClient,
  NodeClientOptions,
  NodeServerInfo,
  retryAfterMsOf,
} from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { endpointList, SyncerConfig } from '../config/syncer.config';

export interface CreateNodeClientOptions {
  /** Where a failed check is reported. Default: a Nest `Logger` with context `NodeClient`. */
  logger?: Pick<Logger, 'warn'>;
  /** The wait between two checks (tests). Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** First wait after a failed check; it doubles per failure. Default 1000. */
  backoffInitialMs?: number;
  /** Cap of that wait. Default 30000. */
  backoffMaxMs?: number;
}

const DEFAULT_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

/**
 * Builds the process-wide NodeClient from `GH_NODE_ENDPOINTS`, connects it, and refuses a node of another network.
 *
 * It is the factory of an async provider, so the client is started and checked before any module's lifecycle hook runs:
 * a worker never sees a client that is not connected yet. A client that fails the network check is stopped again.
 *
 * The check (`server_info`) is retried until the node answers (ruling R99): a node that is busy, rate limits this
 * process or times out does not end the boot. The wait doubles from 1 s to 30 s, or is what a rate-limited node asked
 * for (`NodeThrottledError.retryAfterMs`). Only a node of another network fails at once: that is a wrong configuration.
 */
export async function createNodeClient(
  cfg: Pick<SyncerConfig, 'nodeEndpoints'>,
  profile: NetworkProfile,
  make: (opts: NodeClientOptions) => NodeClient = (opts) => new NodeClient(opts),
  opts: CreateNodeClientOptions = {},
): Promise<NodeClient> {
  const logger = opts.logger ?? new Logger('NodeClient');
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const initial = opts.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
  const max = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  const client = make({ endpoints: endpointList(cfg.nodeEndpoints) });
  try {
    await client.start();
    let info: NodeServerInfo | undefined;
    for (let failures = 0; info === undefined; ) {
      try {
        info = await client.serverInfo();
      } catch (err) {
        failures += 1;
        const backoff = Math.min(initial * 2 ** (failures - 1), max);
        const wait = Math.max(backoff, retryAfterMsOf(err));
        logger.warn(
          `The boot network check (server_info) failed: ${err instanceof Error ? err.message : String(err)}; ` +
            `retry in ${(wait / 1000).toFixed(1)} s`,
        );
        await sleep(wait);
      }
    }
    assertNetwork(info, profile);
  } catch (err) {
    await client.stop();
    throw err;
  }
  return client;
}
