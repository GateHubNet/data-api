import { once } from 'events';
import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { getNetworkProfile } from '../network';
import { assertNetwork, NodeClient, NodeClientOptions } from './node-client';
import { EndpointThrottle, NodeThrottledError, throttleHint } from './node-throttle';

type Json = Record<string, any>;
/** A handler returns the `result`, or `{ error, error_message? }` for a rippled error response. */
type Handler = (req: Json) => Json | undefined;

/**
 * A minimal in-process rippled: answers JSON requests by `id`, records every request and can push stream messages.
 * Commands in `swallow` are never answered; `handlers` override or extend the built-in `server_info`, `subscribe`
 * and `ping` answers.
 */
class MockNode {
  readonly requests: Json[] = [];
  readonly swallow = new Set<string>();
  readonly handlers: Record<string, Handler> = {};
  info: Json = { complete_ledgers: '1-100', pubkey_node: 'n9Mock', validated_ledger: { seq: 100 } };
  connections = 0;
  private readonly sockets = new Set<WebSocket>();

  private constructor(private readonly wss: WebSocketServer) {
    wss.on('connection', (socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (data) => this.onMessage(socket, JSON.parse(data.toString()) as Json));
    });
  }

  static async start(port = 0): Promise<MockNode> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    await once(wss, 'listening');
    return new MockNode(wss);
  }

  get port(): number {
    return (this.wss.address() as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  commands(command: string): Json[] {
    return this.requests.filter((r) => r.command === command);
  }

  pushLedgerClosed(ledgerIndex: number): void {
    const msg = { type: 'ledgerClosed', ledger_index: ledgerIndex, ledger_hash: 'AB'.repeat(32), txn_count: 0 };
    for (const socket of this.sockets) socket.send(JSON.stringify(msg));
  }

  /** Kill every socket without a close frame, so the client sees code 1006. */
  dropAll(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  /** Take the server down: drop every socket and stop listening. */
  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onMessage(socket: WebSocket, req: Json): void {
    this.requests.push(req);
    if (this.swallow.has(req.command)) return;
    const answer = this.handlers[req.command]?.(req) ?? this.builtIn(req);
    const base = { id: req.id, type: 'response' };
    const response =
      answer && 'error' in answer
        ? { ...base, status: 'error', error: answer.error, error_message: answer.error_message, request: req }
        : { ...base, status: 'success', result: answer };
    socket.send(JSON.stringify(response));
  }

  private builtIn(req: Json): Json {
    switch (req.command) {
      case 'server_info':
        return { info: this.info };
      case 'subscribe':
      case 'ping':
        return {};
      default:
        return { error: 'unknownCmd' };
    }
  }
}

/** Small timings so the whole suite stays well under 20 s. */
const FAST: Omit<NodeClientOptions, 'endpoints'> = {
  connectionTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  watchdogIntervalMs: 50,
  silenceTimeoutMs: 0,
  backoffInitialMs: 50,
  backoffMaxMs: 200,
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('NodeClient', () => {
  let nodes: MockNode[] = [];
  let clients: NodeClient[] = [];
  let warnings: string[] = [];

  const logger = {
    log: () => undefined,
    warn: (m: string) => void warnings.push(m),
    error: (m: string) => void warnings.push(m),
  };

  async function mockNode(port?: number): Promise<MockNode> {
    const node = await MockNode.start(port);
    nodes.push(node);
    return node;
  }

  function nodeClient(endpoints: string[], opts: Partial<NodeClientOptions> = {}): NodeClient {
    const client = new NodeClient({ ...FAST, logger, ...opts, endpoints });
    clients.push(client);
    return client;
  }

  beforeEach(() => {
    nodes = [];
    clients = [];
    warnings = [];
  });

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.stop()));
    await Promise.all(nodes.map((n) => n.close()));
    // Global constraint: no request ever carries api_version.
    for (const node of nodes) expect(node.requests.filter((r) => 'api_version' in r)).toEqual([]);
  });

  it('re-subscribes after the server drops the socket (1006)', async () => {
    const node = await mockNode();
    const client = nodeClient([node.url]);
    await client.start();
    await client.subscribe(['ledger']);
    expect(node.commands('subscribe').map((r) => r.streams)).toEqual([['ledger']]);

    const disconnected = once(client, 'disconnected');
    const reconnected = once(client, 'connected');
    node.dropAll();
    expect(await disconnected).toEqual([node.url]);
    expect(await reconnected).toEqual([node.url]);
    expect(node.commands('subscribe').map((r) => r.streams)).toEqual([['ledger'], ['ledger']]);

    const ledgerClosed = once(client, 'ledgerClosed');
    node.pushLedgerClosed(101);
    expect((await ledgerClosed)[0]).toMatchObject({ type: 'ledgerClosed', ledger_index: 101 });

    // Only the supervisor reconnects: xrpl.js's own reconnect of the dropped instance stays disabled.
    await delay(300);
    expect(node.connections).toBe(2);
    expect(client.currentEndpoint).toBe(node.url);
  });

  it('recovers when the first reconnect attempt is refused', async () => {
    const first = await mockNode();
    const port = first.port;
    const client = nodeClient([first.url]);
    await client.start();
    await client.subscribe(['ledger']);

    const disconnected = once(client, 'disconnected');
    await first.close();
    await disconnected;
    expect(client.currentEndpoint).toBeUndefined();

    await delay(2000);
    expect(warnings.some((w) => /ECONNREFUSED|failed/i.test(w))).toBe(true);

    const reconnected = once(client, 'connected');
    const second = await mockNode(port);
    expect(await reconnected).toEqual([second.url]);
    expect(second.commands('subscribe').map((r) => r.streams)).toEqual([['ledger']]);

    const ledgerClosed = once(client, 'ledgerClosed');
    second.pushLedgerClosed(202);
    expect((await ledgerClosed)[0]).toMatchObject({ ledger_index: 202 });
  });

  it('fails over to the second endpoint', async () => {
    const a = await mockNode();
    const b = await mockNode();
    const client = nodeClient([a.url, b.url]);
    await client.start();
    expect(client.currentEndpoint).toBe(a.url);
    await client.subscribe(['ledger']);

    const reconnected = once(client, 'connected');
    await a.close();
    expect(await reconnected).toEqual([b.url]);
    expect(client.currentEndpoint).toBe(b.url);
    expect(b.commands('subscribe').map((r) => r.streams)).toEqual([['ledger']]);

    const ledgerClosed = once(client, 'ledgerClosed');
    b.pushLedgerClosed(303);
    expect((await ledgerClosed)[0]).toMatchObject({ ledger_index: 303 });
  });

  it('starts on the next endpoint when the first one is down', async () => {
    const up = await mockNode();
    const down = await mockNode();
    const downUrl = down.url;
    await down.close();
    const client = nodeClient([downUrl, up.url]);
    await client.start();
    expect(client.currentEndpoint).toBe(up.url);
  });

  it('request times out and retries on another connection', async () => {
    const a = await mockNode();
    const b = await mockNode();
    a.swallow.add('ledger');
    b.handlers.ledger = (req) => ({
      ledger_index: req.ledger_index,
      ledger: { ledger_index: String(req.ledger_index) },
    });
    const client = nodeClient([a.url, b.url]);
    await client.start();
    expect(client.currentEndpoint).toBe(a.url);

    const result = await client.request<Json>({ command: 'ledger', ledger_index: 7 }, { timeoutMs: 300 });
    expect(result).toEqual({ ledger_index: 7, ledger: { ledger_index: '7' } });
    expect(a.commands('ledger')).toHaveLength(1);
    expect(b.commands('ledger')).toHaveLength(1);
    expect(client.currentEndpoint).toBe(b.url);
  });

  it('gives up after the configured retries', async () => {
    const node = await mockNode();
    node.swallow.add('ledger');
    const client = nodeClient([node.url]);
    await client.start();

    await expect(client.request({ command: 'ledger' }, { timeoutMs: 100, retries: 1 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(node.commands('ledger')).toHaveLength(2);
  });

  it('rethrows rippled errors without retrying', async () => {
    const node = await mockNode();
    node.handlers.account_info = () => ({ error: 'actNotFound', error_message: 'Account not found.' });
    const client = nodeClient([node.url]);
    await client.start();

    await expect(client.request({ command: 'account_info', account: 'rX' })).rejects.toMatchObject({
      name: 'RippledError',
      data: expect.objectContaining({ error: 'actNotFound' }),
    });
    expect(node.commands('account_info')).toHaveLength(1);
    expect(node.connections).toBe(1);
  });

  it('replaces a connection whose subscribed streams go silent', async () => {
    const node = await mockNode();
    const client = nodeClient([node.url], { silenceTimeoutMs: 200 });
    await client.start();
    await client.subscribe(['ledger']);

    const reconnected = once(client, 'connected');
    expect(await reconnected).toEqual([node.url]);
    expect(node.connections).toBe(2);
    expect(node.commands('subscribe').map((r) => r.streams)).toEqual([['ledger'], ['ledger']]);
  });

  it('keeps a connection whose subscribed streams keep talking', async () => {
    const node = await mockNode();
    const client = nodeClient([node.url], { silenceTimeoutMs: 200 });
    await client.start();
    await client.subscribe(['ledger']);
    for (let i = 0; i < 6; i++) {
      await delay(100);
      node.pushLedgerClosed(i);
    }
    expect(node.connections).toBe(1);
  });

  it('serverInfo returns the server_info info object', async () => {
    const node = await mockNode();
    node.info = { network_id: 21337, complete_ledgers: '5-10', validated_ledger: { seq: 10 } };
    const client = nodeClient([node.url]);
    await client.start();
    await expect(client.serverInfo()).resolves.toEqual(node.info);
  });

  it('stop() closes the socket and rejects later requests', async () => {
    const node = await mockNode();
    const client = nodeClient([node.url]);
    await client.start();
    await client.stop();
    expect(client.currentEndpoint).toBeUndefined();
    await expect(client.request({ command: 'ping' })).rejects.toThrow(/stopped/);
    await delay(50);
    expect(node.connections).toBe(1);
  });

  it('assertNetwork rejects xahau node for xrpl profile', async () => {
    const node = await mockNode();
    node.info = { network_id: 21337, complete_ledgers: '1-2' };
    const client = nodeClient([node.url]);
    await client.start();
    const info = await client.serverInfo();

    expect(() => assertNetwork(info, getNetworkProfile('xrpl'))).toThrow(
      'Node network_id 21337 does not match GH_NETWORK=xrpl',
    );
    expect(() => assertNetwork({}, getNetworkProfile('xahau'))).toThrow(
      'Node network_id undefined does not match GH_NETWORK=xahau',
    );
    expect(() => assertNetwork({ network_id: 1 }, getNetworkProfile('xrpl'))).toThrow(
      'Node network_id 1 does not match GH_NETWORK=xrpl',
    );
    expect(() => assertNetwork({}, getNetworkProfile('xrpl'))).not.toThrow();
    expect(() => assertNetwork({ network_id: 0 }, getNetworkProfile('xrpl'))).not.toThrow();
    expect(() => assertNetwork(info, getNetworkProfile('xahau'))).not.toThrow();
    expect(() => assertNetwork({ network_id: 21338 }, getNetworkProfile('xahau'))).not.toThrow();
  });

  describe("a node's rate-limit answers (ruling R98)", () => {
    const limited = (ms: number) => ({
      error: 'slowDown',
      error_message: `rate limit: units quota (50000 per 10s) exhausted, retry in ~${ms}ms`,
    });

    /** A throttle of its own, so that no test sees another test's pauses; `pauses` records each pause it starts. */
    function throttle(opts: ConstructorParameters<typeof EndpointThrottle>[0] = {}) {
      const t = new EndpointThrottle(opts);
      const pauses: Array<{ endpoint: string; ms: number }> = [];
      t.on('pause', (event: { endpoint: string; ms: number }) => pauses.push(event));
      return { t, pauses };
    }

    it('pauses the endpoint until the hint expires: no request reaches it meanwhile, then it is used again', async () => {
      const node = await mockNode();
      let answers = 0;
      node.handlers.ledger = () => (answers++ === 0 ? limited(400) : { ledger_index: 7 });
      const { t, pauses } = throttle();
      const client = nodeClient([node.url], { throttle: t });
      await client.start();

      const first = await client.request({ command: 'ledger' }).catch((err: unknown) => err);
      expect(first).toBeInstanceOf(NodeThrottledError);
      expect((first as NodeThrottledError).retryAfterMs).toBeGreaterThanOrEqual(400);
      expect((first as NodeThrottledError).retryAfterMs).toBeLessThanOrEqual(1_000);
      expect((first as Error).message).toContain('retry in ~400ms');

      // While paused: refused at once, nothing is sent.
      await expect(client.request({ command: 'ledger' })).rejects.toBeInstanceOf(NodeThrottledError);
      await expect(client.request({ command: 'server_info' })).rejects.toBeInstanceOf(NodeThrottledError);
      expect(node.commands('ledger')).toHaveLength(1);
      expect(node.commands('server_info')).toHaveLength(0);

      await delay(800);
      await expect(client.request({ command: 'ledger' })).resolves.toEqual({ ledger_index: 7 });
      expect(node.commands('ledger')).toHaveLength(2);
      // One pause, logged once with the remaining time.
      expect(pauses).toEqual([
        { endpoint: node.url, host: expect.any(String), ms: expect.any(Number), reason: expect.any(String) },
      ]);
      expect(warnings.filter((w) => /rate limit/i.test(w))).toHaveLength(1);
      expect(warnings.find((w) => /rate limit/i.test(w))).toMatch(/for \d+(\.\d+)? s/);
      expect(node.connections).toBe(1); // the connection itself is kept
    });

    it('treats slowDown and tooBusy without a hint as a pause of the default length', async () => {
      for (const error of ['slowDown', 'tooBusy']) {
        const node = await mockNode();
        node.handlers.fee = () => ({ error });
        const { t } = throttle({ defaultPauseMs: 300 });
        const client = nodeClient([node.url], { throttle: t });
        await client.start();
        const err = (await client.request({ command: 'fee' }).catch((e: unknown) => e)) as NodeThrottledError;
        expect(err).toBeInstanceOf(NodeThrottledError);
        expect(err.retryAfterMs).toBeGreaterThan(200);
        expect(err.retryAfterMs).toBeLessThanOrEqual(300);
        await expect(client.request({ command: 'fee' })).rejects.toBeInstanceOf(NodeThrottledError);
        expect(node.commands('fee')).toHaveLength(1);
      }
    });

    it('caps a pause at maxPauseMs', async () => {
      const node = await mockNode();
      node.handlers.ledger = () => limited(929_624);
      const { t } = throttle({ maxPauseMs: 500 });
      const client = nodeClient([node.url], { throttle: t });
      await client.start();
      const err = (await client.request({ command: 'ledger' }).catch((e: unknown) => e)) as NodeThrottledError;
      expect(err.retryAfterMs).toBeLessThanOrEqual(500);
      await delay(600);
      expect(t.waitMs([node.url])).toBe(0);
    });

    it('fails over to another endpoint while one is paused, and does not go back to it before the pause ends', async () => {
      const a = await mockNode();
      const b = await mockNode();
      a.handlers.ledger = () => limited(5_000);
      b.handlers.ledger = () => ({ ledger_index: 8 });
      const { t } = throttle();
      const client = nodeClient([a.url, b.url], { throttle: t });
      await client.start();
      expect(client.currentEndpoint).toBe(a.url);

      await expect(client.request({ command: 'ledger' })).resolves.toEqual({ ledger_index: 8 });
      expect(client.currentEndpoint).toBe(b.url);
      for (let i = 0; i < 3; i++) await client.request({ command: 'ledger' });
      expect(a.commands('ledger')).toHaveLength(1);
      expect(b.commands('ledger')).toHaveLength(4);

      // b drops: the client must not reconnect to a while a is paused.
      b.handlers.ledger = () => limited(5_000);
      await expect(client.request({ command: 'ledger' })).rejects.toBeInstanceOf(NodeThrottledError);
      await delay(200);
      expect(a.connections).toBe(1);
    });

    it('does not even connect to a paused endpoint: a connection refused with the rate-limit text pauses it', async () => {
      const node = await mockNode();
      let refusals = 1;
      node.handlers.subscribe = () => (refusals-- > 0 ? limited(400) : {});
      const { t, pauses } = throttle();
      const client = nodeClient([node.url], { throttle: t });
      await client.subscribe(['ledger']); // recorded: sent with the connect
      const started = Date.now();
      await client.start();
      // The first attempt was refused; the next one waited for the hint instead of the 50 ms backoff.
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
      expect(node.connections).toBe(2);
      expect(pauses).toHaveLength(1);
      expect(warnings.some((w) => /Cannot connect/.test(w) && /rate limit/.test(w))).toBe(true);
    });

    it('shares a pause between the clients of one throttle (the process): a second client sends nothing either', async () => {
      const node = await mockNode();
      node.handlers.ledger = () => limited(5_000);
      const { t } = throttle();
      const one = nodeClient([node.url], { throttle: t });
      const two = nodeClient([node.url], { throttle: t });
      await one.start();
      await two.start();
      await expect(one.request({ command: 'ledger' })).rejects.toBeInstanceOf(NodeThrottledError);
      await expect(two.request({ command: 'ledger' })).rejects.toBeInstanceOf(NodeThrottledError);
      expect(node.commands('ledger')).toHaveLength(1);
    });

    it("rethrows the node's own answer when the request has no attempt left but another endpoint is usable", async () => {
      const a = await mockNode();
      const b = await mockNode();
      a.handlers.ledger = () => limited(5_000);
      b.handlers.ledger = () => ({ ledger_index: 9 });
      const { t } = throttle();
      const client = nodeClient([a.url, b.url], { throttle: t });
      await client.start();

      const err = (await client.request({ command: 'ledger' }, { retries: 0 }).catch((e: unknown) => e)) as Error;
      // Not "nothing is sent to it for 0.0 s": nothing needs waiting for, the next request goes to b.
      expect(err).not.toBeInstanceOf(NodeThrottledError);
      expect(err).toMatchObject({ name: 'RippledError', message: expect.stringContaining('rate limit') });
      await expect(client.request({ command: 'ledger' })).resolves.toEqual({ ledger_index: 9 });
      expect(a.commands('ledger')).toHaveLength(1);
    });

    it('never logs the credentials, path or query of an endpoint, only scheme://host:port', async () => {
      const node = await mockNode();
      node.handlers.ledger = () => limited(300);
      const lines: string[] = [];
      const capture = {
        log: (m: string) => void lines.push(m),
        warn: (m: string) => void lines.push(m),
        error: (m: string) => void lines.push(m),
      };
      const endpoint = `ws://user:secret@127.0.0.1:${node.port}/ws?token=hush`;
      const { t } = throttle();
      const client = nodeClient([endpoint], { throttle: t, logger: capture });
      await client.start();
      await client.request({ command: 'ledger' }).catch(() => undefined); // the pause warning
      const reconnected = once(client, 'connected');
      node.dropAll(); // "Node ... disconnected; reconnecting", "Connected to ..."
      await reconnected;
      await client.stop(); // "Disconnected from ..."

      expect(lines.length).toBeGreaterThanOrEqual(4);
      for (const line of lines) {
        expect(line).not.toMatch(/secret|user:|hush|token|\/ws/);
      }
      expect(lines.filter((line) => line.includes(`ws://127.0.0.1:${node.port}`)).length).toBeGreaterThanOrEqual(4);
    });

    it('names a rejected endpoint without its credentials', () => {
      expect(() => new NodeClient({ endpoints: ['https://user:secret@node.example/x?token=hush'] })).toThrow(
        'Invalid node endpoint "https://node.example": expected a ws:// or wss:// URL',
      );
    });

    it('reads the hint of the answer texts the public nodes send', () => {
      expect(throttleHint(new Error('rate limit: units quota (10000 per 60s) exhausted, retry in ~109117ms'))).toEqual({
        retryInMs: 109_117,
      });
      expect(throttleHint({ data: { error: 'slowDown' } })).toEqual({});
      expect(throttleHint(new Error('Unexpected server response: 429'))).toEqual({});
      expect(throttleHint(new Error('timeout'))).toBeUndefined();
      expect(throttleHint({ data: { error: 'lgrNotFound' } })).toBeUndefined();
    });
  });
});
