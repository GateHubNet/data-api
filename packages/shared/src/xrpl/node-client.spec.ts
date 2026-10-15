import { once } from 'events';
import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { getNetworkProfile } from '../network';
import { assertNetwork, NodeClient, NodeClientOptions } from './node-client';

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
});
