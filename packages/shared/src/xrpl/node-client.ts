import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { Client, DisconnectedError, NotConnectedError, Request, RippledError, TimeoutError } from 'xrpl';
import { NetworkName, NetworkProfile } from '../network';
import { EndpointThrottle, nodeThrottle, NodeThrottledError, throttleHint } from './node-throttle';

export interface NodeClientLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface NodeClientOptions {
  /** rippled / xahaud websocket URLs (`ws://` or `wss://`), tried round-robin. */
  endpoints: string[];
  /** Limit for one websocket handshake. Default 20000. */
  connectionTimeoutMs?: number;
  /** Default per-request timeout; also the xrpl.js heartbeat (ping) interval. Default 30000. */
  requestTimeoutMs?: number;
  /** How often the watchdog checks the live connection. Default 5000. */
  watchdogIntervalMs?: number;
  /** Replace the connection when subscribed streams have been silent for longer than this. Default 30000; 0 = off. */
  silenceTimeoutMs?: number;
  /** First reconnect delay; it doubles after every failed round over all endpoints. Default 1000. */
  backoffInitialMs?: number;
  /** Cap for the reconnect delay. Default 30000. */
  backoffMaxMs?: number;
  /** Defaults to a Nest `Logger` with context `NodeClient`. */
  logger?: NodeClientLogger;
  /** Where the pauses that rate-limiting nodes asked for are kept. Default: `nodeThrottle`, shared by the process. */
  throttle?: EndpointThrottle;
}

export interface NodeRequestOptions {
  /** Limit for waiting for a connection, and again for the response. Defaults to `requestTimeoutMs`. */
  timeoutMs?: number;
  /** Extra attempts after a disconnect or timeout, each on a fresh connection. Default 3. */
  retries?: number;
}

/** The `info` object of a `server_info` result; only the fields this codebase reads are typed. */
export interface NodeServerInfo {
  network_id?: number;
  complete_ledgers: string;
  pubkey_node?: string;
  validated_ledger?: { seq: number };
  [field: string]: unknown;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;
const DEFAULT_SILENCE_TIMEOUT_MS = 30_000;
const DEFAULT_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_RETRIES = 3;
/** How long `stop()` waits for sockets to close. A socket that is still handshaking may never report its close. */
const STOP_GRACE_MS = 2_000;

/** Stream messages the supervisor forwards under the same event name; each one also feeds the silence watchdog. */
const STREAM_EVENTS = [
  'ledgerClosed',
  'validationReceived',
  'manifestReceived',
  'transaction',
  'peerStatusChange',
  'consensusPhase',
] as const;

/** `network_id` values a node may report for each `GH_NETWORK`. Mainnet rippled omits the field. */
const ACCEPTED_NETWORK_IDS: Record<NetworkName, ReadonlyArray<number | undefined>> = {
  xrpl: [undefined, 0],
  xahau: [21337, 21338],
};

/**
 * One resilient websocket connection to rippled / xahaud, shared by everything in a process that talks to a node.
 *
 * It owns one `xrpl.Client` at a time and never relies on xrpl.js reconnecting: an instance that drops, stops
 * answering or goes silent is retired and a new one is connected, trying the endpoints round-robin with a capped
 * exponential backoff. Subscribed streams are remembered and sent again on every new connection.
 *
 * **Rate limits (ruling R98).** A node that answers a request, or refuses a connection, with a rate-limit answer
 * (`rate limit: ... retry in ~<N>ms`, `slowDown`, `tooBusy`, HTTP 429) is paused for the wait it names (plus a margin; a
 * default 10 s without a hint; at most 20 min), in a throttle the whole process shares: nothing is sent to it and no
 * connection to it is attempted until the pause ends, by this client or any other. Meanwhile requests go to another
 * configured endpoint that is not paused (the connection is moved there); when every endpoint is paused a request fails
 * at once with `NodeThrottledError` (its `retryAfterMs` says how long to wait), and the connect loop waits for the first
 * pause to end. A connection to a paused endpoint is kept while there is no other one, so its streams keep flowing. Each
 * pause is logged once, with its length.
 *
 * Events: `connected`(endpoint), `disconnected`(endpoint), and the stream messages `ledgerClosed`,
 * `validationReceived`, `manifestReceived` (plus `transaction`, `peerStatusChange`, `consensusPhase`) with the raw
 * message. It never emits `error`.
 */
export class NodeClient extends EventEmitter {
  private readonly endpoints: string[];
  private readonly connectionTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly silenceTimeoutMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly logger: NodeClientLogger;
  private readonly throttle: EndpointThrottle;

  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private readonly streams = new Set<string>();
  /** The live instance and its endpoint. */
  private client?: Client;
  private endpoint?: string;
  /** The instance the connect loop is currently handshaking with. */
  private pending?: Client;
  /** The running connect loop, if any; every caller that needs a connection waits on it. */
  private connecting?: Promise<Client>;
  private nextEndpoint = 0;
  private backoffMs: number;
  /** Whether the live instance has passed a watchdog check. One that dies before that reconnects after a backoff. */
  private healthy = false;
  private backoffBeforeReconnect = false;
  private lastStreamAt = 0;
  private watchdog?: NodeJS.Timeout;
  private sleeping?: { timer: NodeJS.Timeout; wake: () => void };
  /** The endpoint of each instance this client made. */
  private readonly endpointOf = new WeakMap<Client, string>();

  constructor(opts: NodeClientOptions) {
    super();
    if (!opts.endpoints?.length) {
      throw new Error('NodeClient needs at least one endpoint');
    }
    for (const endpoint of opts.endpoints) {
      if (!/^wss?:\/\//.test(endpoint)) {
        throw new Error(`Invalid node endpoint "${endpoint}": expected a ws:// or wss:// URL`);
      }
    }
    this.endpoints = [...opts.endpoints];
    this.connectionTimeoutMs = opts.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.watchdogIntervalMs = opts.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
    this.backoffInitialMs = opts.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.backoffMs = this.backoffInitialMs;
    this.logger = opts.logger ?? nestLogger();
    this.throttle = opts.throttle ?? nodeThrottle;
  }

  /** 0 when an endpoint of this client may be used now, else how long until the first of them may. */
  throttledForMs(): number {
    return this.throttle.waitMs(this.endpoints);
  }

  /** Endpoint of the live connection; undefined while (re)connecting or stopped. */
  get currentEndpoint(): string | undefined {
    return this.client ? this.endpoint : undefined;
  }

  /** Start the watchdog and connect. Resolves after the first successful connect; until then it keeps trying. */
  async start(): Promise<void> {
    if (this.state === 'stopped') {
      throw new Error('NodeClient is stopped');
    }
    if (this.state === 'idle') {
      this.state = 'running';
      this.watchdog = setInterval(() => this.checkHealth(), this.watchdogIntervalMs);
    }
    await this.connection();
  }

  /** Close everything and clear every timer. Final: a stopped client cannot be started again. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (this.sleeping) {
      clearTimeout(this.sleeping.timer);
      this.sleeping.wake();
      this.sleeping = undefined;
    }
    const closing: Promise<void>[] = [];
    if (this.pending) {
      closing.push(this.retire(this.pending));
      this.pending = undefined;
    }
    const { client, endpoint } = this;
    if (client) {
      this.client = undefined;
      this.endpoint = undefined;
      closing.push(this.retire(client));
      this.logger.log(`Disconnected from ${endpoint}`);
      this.safeEmit('disconnected', endpoint);
    }
    await settleWithin(Promise.all(closing), STOP_GRACE_MS);
  }

  /**
   * Subscribe to rippled streams (e.g. `ledger`, `validations`, `manifests`). They are remembered and sent again on
   * every new connection. Before `start()` this only records them. A rippled error (e.g. `malformedStream`) is thrown
   * and the streams are forgotten.
   */
  async subscribe(streams: string[]): Promise<void> {
    const added = [...new Set(streams)].filter((stream) => !this.streams.has(stream));
    if (added.length === 0) return;
    if (this.streams.size === 0) {
      this.lastStreamAt = Date.now();
    }
    for (const stream of added) this.streams.add(stream);
    if (this.state !== 'running') return;
    try {
      await this.request({ command: 'subscribe', streams: added });
    } catch (err) {
      if (err instanceof RippledError) {
        for (const stream of added) this.streams.delete(stream);
      }
      throw err;
    }
  }

  /**
   * Send one request and return its `result`. A disconnect or timeout retires the connection and the request is
   * retried on a fresh one (`retries` times). Rippled errors (`RippledError`, e.g. `actNotFound`, `lgrNotFound`) are
   * rethrown at once. The request is sent as given: no `api_version` is added.
   *
   * A rate-limit answer pauses its endpoint (see the class description); the request is retried on another endpoint
   * that is not paused, and fails with `NodeThrottledError` when there is none. While every endpoint is paused it fails
   * with `NodeThrottledError` without sending anything.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async request<T = any>(req: Record<string, unknown>, opts: NodeRequestOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    const retries = opts.retries ?? DEFAULT_RETRIES;
    const payload = { ...req };
    delete payload.id; // xrpl.js assigns ids; a caller's id could collide with a pending one.
    let throttled: unknown;
    for (let attempt = 0; ; attempt += 1) {
      if (this.state === 'running') {
        const wait = this.throttledForMs();
        if (wait > 0) throw this.throttledError(wait, throttled);
      }
      let client: Client | undefined;
      try {
        client = await this.connection(timeoutMs);
        const response = (await client.connection.request(payload as unknown as Request, timeoutMs)) as { result: T };
        return response.result;
      } catch (err) {
        const endpoint = client ? this.endpointOf.get(client) : undefined;
        if (endpoint !== undefined && throttleHint(err) !== undefined) {
          this.paused(endpoint, err, `Request ${String(req.command)}`);
          throttled = err;
          const wait = this.throttledForMs();
          if (this.state !== 'running' || wait > 0 || attempt >= retries) throw this.throttledError(wait, err);
          // Another endpoint may be used: move the connection there and send the request again.
          if (client) this.replace(client, 'is rate limiting this client');
          continue;
        }
        if (this.state !== 'running' || !isFailoverError(err) || attempt >= retries) throw err;
        this.logger.warn(
          `Request ${String(req.command)} failed (${errorMessage(err)}); retrying on a fresh connection (${attempt + 1}/${retries})`,
        );
        if (client) this.replace(client, `failed a request (${errorMessage(err)})`);
      }
    }
  }

  /** The `info` object of `server_info`. */
  async serverInfo(): Promise<NodeServerInfo> {
    const result = await this.request<{ info: NodeServerInfo }>({ command: 'server_info' });
    return result.info;
  }

  /** A `NodeThrottledError` for a wait of `ms` (every endpoint paused), with the answer that started it if known. */
  private throttledError(ms: number, cause?: unknown): NodeThrottledError {
    const reason = cause instanceof Error ? cause.message : 'the node asked this client to slow down';
    return new NodeThrottledError([...this.endpoints], ms, reason);
  }

  /** Pause `endpoint` for the rate-limit answer `err` (`what` failed); logged once per pause. */
  private paused(endpoint: string, err: unknown, what: string): void {
    const { ms, started } = this.throttle.pause(endpoint, err);
    if (!started) return;
    this.logger.warn(
      `${what} was refused by ${endpoint}: ${errorMessage(err)}. It rate limits this client: nothing is sent to it ` +
        `for ${(ms / 1000).toFixed(1)} s`,
    );
  }

  /** The live instance, waiting for the connect loop when there is none (at most `timeoutMs`, when given). */
  private connection(timeoutMs?: number): Promise<Client> {
    if (this.state !== 'running') {
      return Promise.reject(new Error(this.state === 'idle' ? 'NodeClient is not started' : 'NodeClient is stopped'));
    }
    if (this.client) {
      const live = this.client;
      const endpoint = this.endpoint as string;
      const movable = this.throttle.remainingMs(endpoint) > 0 && this.throttledForMs() === 0;
      if (live.isConnected() && !movable) return Promise.resolve(live);
      this.replace(live, live.isConnected() ? 'is rate limiting this client' : 'is not connected');
    }
    const connecting = this.startConnecting();
    if (timeoutMs === undefined) return connecting;
    return withTimeout(connecting, timeoutMs, () => new NotConnectedError(`No node connection within ${timeoutMs} ms`));
  }

  private startConnecting(): Promise<Client> {
    if (!this.connecting) {
      const loop = this.connectLoop();
      this.connecting = loop;
      const clear = () => {
        if (this.connecting === loop) this.connecting = undefined;
      };
      loop.then(clear, clear);
    }
    return this.connecting;
  }

  /** Try endpoints round-robin until one connects (and accepts the remembered subscriptions), or until stopped. */
  private async connectLoop(): Promise<Client> {
    if (this.backoffBeforeReconnect) {
      this.backoffBeforeReconnect = false;
      await this.backoff();
    }
    let failures = 0;
    for (;;) {
      this.assertRunning();
      const wait = this.throttledForMs();
      if (wait > 0) {
        // Every endpoint is paused: no connection attempt until the first pause ends.
        await this.sleep(wait);
        continue;
      }
      const endpoint = this.nextUsableEndpoint();
      const client = this.createClient(endpoint);
      this.pending = client;
      try {
        await client.connection.connect();
        if (this.streams.size > 0) {
          const subscribe = { command: 'subscribe', streams: [...this.streams] };
          await client.connection.request(subscribe as unknown as Request, this.requestTimeoutMs);
        }
        this.assertRunning();
        if (!client.isConnected()) throw new NotConnectedError('Connection closed while subscribing');
      } catch (err) {
        if (this.pending === client) this.pending = undefined;
        void this.retire(client);
        this.assertRunning();
        if (throttleHint(err) !== undefined) {
          // Refused because this client sends too much: pause the endpoint (and try another) instead of backing off.
          this.paused(endpoint, err, 'Connecting');
          this.logger.warn(`Cannot connect to ${endpoint}: ${errorMessage(err)}`);
          continue;
        }
        failures += 1;
        this.logger.warn(`Cannot connect to ${endpoint}: ${errorMessage(err)}`);
        if (failures % this.endpoints.length === 0) await this.backoff();
        continue;
      }
      this.pending = undefined;
      this.client = client;
      this.endpoint = endpoint;
      this.healthy = false;
      this.lastStreamAt = Date.now();
      const subscribed = this.streams.size > 0 ? ` (streams: ${[...this.streams].join(', ')})` : '';
      this.logger.log(`Connected to ${endpoint}${subscribed}`);
      this.safeEmit('connected', endpoint);
      return client;
    }
  }

  /** The next endpoint, round-robin, that is not paused (the caller made sure there is one). */
  private nextUsableEndpoint(): string {
    for (let tried = 0; tried < this.endpoints.length; tried++) {
      const endpoint = this.endpoints[this.nextEndpoint];
      this.nextEndpoint = (this.nextEndpoint + 1) % this.endpoints.length;
      if (this.throttle.remainingMs(endpoint) === 0) return endpoint;
    }
    return this.endpoints[this.nextEndpoint];
  }

  /** Sleep for the current backoff, then double it (capped). `stop()` cuts the sleep short. */
  private async backoff(): Promise<void> {
    const ms = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
    this.logger.warn(`Reconnecting in ${ms} ms`);
    await this.sleep(ms);
  }

  /** Sleep `ms`; `stop()` cuts it short (and then this throws). */
  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.sleeping = { timer: setTimeout(resolve, ms), wake: resolve };
    });
    this.sleeping = undefined;
    this.assertRunning();
  }

  /** Watchdog tick: replace an instance that is disconnected, or whose subscribed streams went silent. */
  private checkHealth(): void {
    if (this.state !== 'running') return;
    const client = this.client;
    if (!client) {
      if (!this.connecting) void this.startConnecting().catch(() => undefined);
      return;
    }
    if (!client.isConnected()) {
      this.replace(client, 'is not connected');
      return;
    }
    if (this.streams.size > 0 && this.silenceTimeoutMs > 0) {
      const silentMs = Date.now() - this.lastStreamAt;
      if (silentMs > this.silenceTimeoutMs) {
        this.replace(client, `sent no stream message for ${silentMs} ms`);
        return;
      }
    }
    this.healthy = true;
    this.backoffMs = this.backoffInitialMs;
  }

  /** Retire the live instance (a no-op for an instance that was already replaced) and start connecting a new one. */
  private replace(client: Client, reason: string): void {
    if (client !== this.client) return;
    const endpoint = this.endpoint;
    this.client = undefined;
    this.endpoint = undefined;
    this.backoffBeforeReconnect = !this.healthy;
    void this.retire(client);
    this.logger.warn(`Node ${endpoint} ${reason}; reconnecting`);
    this.safeEmit('disconnected', endpoint);
    if (this.state === 'running') void this.startConnecting().catch(() => undefined);
  }

  private createClient(endpoint: string): Client {
    const client = new Client(endpoint, {
      connectionTimeout: this.connectionTimeoutMs,
      timeout: this.requestTimeoutMs,
    });
    this.endpointOf.set(client, endpoint);
    disableAutoReconnect(client);
    // Listeners are attached once, here, for the lifetime of this instance; `retire()` removes them.
    client.on('error', (code: unknown, message: unknown) =>
      this.logger.warn(`Node ${endpoint} error: ${code} ${message}`),
    );
    client.on('disconnected', (code: number) => this.replace(client, `disconnected (code ${code})`));
    const emitter: EventEmitter = client;
    for (const event of STREAM_EVENTS) {
      emitter.on(event, (message: unknown) => {
        if (client !== this.client) return;
        this.lastStreamAt = Date.now();
        this.safeEmit(event, message);
      });
    }
    return client;
  }

  /** Detach an instance and close it. Never throws; resolves when closed (a handshaking socket may never resolve). */
  private retire(client: Client): Promise<void> {
    client.removeAllListeners();
    client.on('error', () => undefined); // an EventEmitter 'error' without a listener would throw
    return client.disconnect().then(
      () => undefined,
      () => undefined,
    );
  }

  private assertRunning(): void {
    if (this.state !== 'running') throw new Error('NodeClient is stopped');
  }

  /** A throwing listener must not break the socket handling that emitted the event. */
  private safeEmit(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (err) {
      this.logger.error(`NodeClient '${event}' listener threw`, err);
    }
  }
}

/**
 * Throw unless the node's `network_id` belongs to the configured network: `xrpl` accepts none or 0, `xahau` 21337
 * (mainnet) or 21338 (testnet).
 */
export function assertNetwork(info: { network_id?: number }, profile: NetworkProfile): void {
  const networkId = info.network_id ?? undefined;
  if (!ACCEPTED_NETWORK_IDS[profile.name].includes(networkId)) {
    throw new Error(`Node network_id ${String(networkId)} does not match GH_NETWORK=${profile.name}`);
  }
}

/**
 * xrpl.js 2.14 reconnects an instance by itself after an unexpected close (once: a failed attempt is never retried,
 * and a close without a code never reconnects) and after a failed heartbeat ping. The supervisor replaces instances
 * instead, so both paths become a plain close: the instance emits `disconnected` and gets retired.
 */
function disableAutoReconnect(client: Client): void {
  const connection = client.connection as unknown as {
    intentionalDisconnect: () => void;
    reconnect: () => Promise<void>;
  };
  connection.intentionalDisconnect = () => undefined;
  connection.reconnect = async () => {
    await client.connection.disconnect();
  };
}

/** Errors after which another connection may succeed: the connection, not the request, failed. */
function isFailoverError(err: unknown): boolean {
  return (
    err instanceof NotConnectedError ||
    err instanceof DisconnectedError ||
    err instanceof TimeoutError ||
    (err instanceof Error && /websocket was closed/i.test(err.message))
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

/** Wait for `promise` to settle, but no longer than `ms`. Never rejects and leaves no timer behind. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return withTimeout(promise, ms, () => new Error('timeout')).then(
    () => undefined,
    () => undefined,
  );
}

function nestLogger(): NodeClientLogger {
  const logger = new Logger('NodeClient');
  return {
    log: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
    error: (message, error) => {
      if (error instanceof Error) logger.error(`${message}: ${error.message}`, error.stack);
      else if (error === undefined) logger.error(message);
      else logger.error(`${message}: ${String(error)}`);
    },
  };
}
