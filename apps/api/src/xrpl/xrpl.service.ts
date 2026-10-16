import {
  assertNetwork,
  NetworkProfile,
  NodeClient,
  NodeClientOptions,
  NodeRequestOptions,
  NodeServerInfo,
  nodeThrottle,
  NodeThrottledError,
  ShutdownSignals,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { NotConnectedError } from 'xrpl';
import { ApiConfig, endpointList, NETWORK_PROFILE } from '../config/api.config';

/** The API is latency-sensitive: a request, and the wait for the first connection, give up after 10 s. */
export const NODE_REQUEST_TIMEOUT_MS = 10_000;
/** One extra attempt on a fresh connection after a disconnect or timeout (the shared NodeClient default is 3). */
export const NODE_REQUEST_RETRIES = 1;

/** The part of the `NodeClient` this service uses; tests stand in for it. */
export type NodeClientLike = Pick<NodeClient, 'start' | 'stop' | 'request'>;

export type NodeClientFactory = (options: NodeClientOptions) => NodeClientLike;

/** Provide a `NodeClientFactory` under this token to replace the real `NodeClient` (tests). */
export const NODE_CLIENT_FACTORY = Symbol('NODE_CLIENT_FACTORY');

/**
 * The live-node service: the endpoints that need the current ledger state (balances, open orders) and the binary
 * codec's definitions ask the rippled / xahaud node through it.
 *
 * It is the shared `NodeClient` (reconnects, endpoint rotation, backoff) over `GH_NODE_ENDPOINTS`, with the short
 * timeouts of an API: the first request starts it, checks that the node belongs to `GH_NETWORK` (`assertNetwork`), and
 * every later request reuses the connection. Concurrent first requests share one start. A request that cannot get a
 * connection within the timeout fails with `NotConnectedError`; the client keeps connecting in the background, so the
 * requests after it find the node as soon as it is there. A node of another network fails every request with the
 * `assertNetwork` message and is dropped, so the next request tries again.
 *
 * Errors of the node itself (`RippledError`: `actNotFound`, `lgrNotFound`, ...) are rethrown unchanged, as the
 * `NodeClient` does. No `api_version` is sent: both servers default to v1.
 *
 * While every endpoint is paused because the node asked this process to slow down (ruling R98, the process-wide
 * `nodeThrottle`), a request fails at once with `NodeThrottledError`: it neither waits out the request timeout nor makes
 * a new client that would knock at the node again.
 */
@Injectable()
export class XrplService implements OnModuleDestroy {
  private readonly endpoints: string[];
  private readonly factory: NodeClientFactory;
  /** The client of the connect attempt in progress or finished. */
  private client?: NodeClientLike;
  /** The connect attempt: pending while the node is unreachable, forgotten when it fails. */
  private starting?: Promise<NodeClientLike>;
  private stopped = false;

  constructor(
    config: ApiConfig,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
    signals: ShutdownSignals,
    @Optional() @Inject(NODE_CLIENT_FACTORY) factory?: NodeClientFactory,
  ) {
    this.endpoints = endpointList(config.nodeEndpoints);
    this.factory = factory ?? ((options) => new NodeClient(options));
    signals.register('node-client', () => this.stop());
  }

  /**
   * One rippled request; resolves with the `result`. `opts` override the API defaults (10 s, one retry), e.g. for a
   * request that must not hold up the boot.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async request<T = any>(req: Record<string, unknown>, opts: NodeRequestOptions = {}): Promise<T> {
    if (this.stopped) throw new Error('XrplService is stopped');
    const paused = nodeThrottle.waitMs(this.endpoints);
    if (paused > 0) {
      throw new NodeThrottledError(this.endpoints, paused, 'the node asked this process to slow down');
    }
    const timeoutMs = opts.timeoutMs ?? NODE_REQUEST_TIMEOUT_MS;
    const client = await this.connected(timeoutMs);
    return client.request<T>(req, { timeoutMs, retries: opts.retries ?? NODE_REQUEST_RETRIES });
  }

  /** Close the connection. Final: later requests fail. Safe to call any number of times. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const { client } = this;
    this.client = undefined;
    this.starting = undefined;
    await client?.stop();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** The started client, waiting at most `timeoutMs` for the first connection. */
  private connected(timeoutMs: number): Promise<NodeClientLike> {
    if (!this.starting) {
      const attempt = this.open();
      this.starting = attempt;
      // A failed attempt is forgotten so that the next request makes a new one; handling it here also keeps it from
      // being reported as unhandled when every caller has already given up waiting.
      attempt.catch(() => {
        if (this.starting === attempt) this.starting = undefined;
      });
    }
    return withTimeout(
      this.starting,
      timeoutMs,
      () => new NotConnectedError(`No node connection within ${timeoutMs} ms`),
    );
  }

  /** Create the client, wait for the first connect and make sure the node is on the configured network. */
  private async open(): Promise<NodeClientLike> {
    const client = this.factory({ endpoints: this.endpoints, requestTimeoutMs: NODE_REQUEST_TIMEOUT_MS });
    this.client = client;
    try {
      await client.start();
      const { info } = await client.request<{ info: NodeServerInfo }>(
        { command: 'server_info' },
        { timeoutMs: NODE_REQUEST_TIMEOUT_MS, retries: NODE_REQUEST_RETRIES },
      );
      assertNetwork(info, this.profile);
      return client;
    } catch (err) {
      if (this.client === client) this.client = undefined;
      // After stop() the client is stopped already.
      if (!this.stopped) await client.stop().catch(() => undefined);
      throw err;
    }
  }
}

/** `promise`, or `timeoutError()` when it has not settled after `ms`. A late outcome of `promise` is ignored. */
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
