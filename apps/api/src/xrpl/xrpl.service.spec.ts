import {
  getNetworkProfile,
  NetworkName,
  NodeClientOptions,
  nodeThrottle,
  NodeThrottledError,
  ShutdownSignals,
} from '@gatehub/data-api-shared';
import { NotConnectedError, RippledError } from 'xrpl';
import { ApiConfig } from '../config/api.config';
import { NODE_REQUEST_RETRIES, NODE_REQUEST_TIMEOUT_MS, NodeClientLike, XrplService } from './xrpl.service';

interface FakeClient extends NodeClientLike {
  start: jest.Mock;
  stop: jest.Mock;
  request: jest.Mock;
}

function fakeClient(over: Partial<Record<keyof FakeClient, unknown>> = {}): FakeClient {
  return {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    request: jest.fn(async (req: Record<string, unknown>) =>
      req.command === 'server_info' ? { info: { network_id: undefined, complete_ledgers: '1-2' } } : { echoed: req },
    ),
    ...over,
  } as unknown as FakeClient;
}

function setup(opts: { network?: NetworkName; endpoints?: string; clients?: FakeClient[] } = {}) {
  const network = opts.network ?? 'xrpl';
  const config = Object.assign(new ApiConfig(), {
    network,
    nodeEndpoints: opts.endpoints ?? 'wss://a.example , wss://b.example',
  });
  const queue = [...(opts.clients ?? [fakeClient()])];
  const created: { options: NodeClientOptions; client: FakeClient }[] = [];
  const factory = jest.fn((options: NodeClientOptions) => {
    const client = queue.shift() ?? fakeClient();
    created.push({ options, client });
    return client;
  });
  const signals = new ShutdownSignals({
    process: { on: () => undefined, removeListener: () => undefined, exit: () => undefined },
  });
  jest.spyOn(signals, 'register');
  const service = new XrplService(config, getNetworkProfile(network), signals, factory);
  return { service, factory, created, signals };
}

describe('XrplService', () => {
  afterEach(() => jest.useRealTimers());

  it('connects lazily: nothing happens until the first request', () => {
    const { factory } = setup();
    expect(factory).not.toHaveBeenCalled();
  });

  it('builds the NodeClient over the configured endpoints with the short API timeout', async () => {
    const { service, created } = setup();
    await service.request({ command: 'ping' });
    expect(created).toHaveLength(1);
    expect(created[0].options.endpoints).toEqual(['wss://a.example', 'wss://b.example']);
    expect(created[0].options.requestTimeoutMs).toBe(10_000);
    expect(NODE_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(NODE_REQUEST_RETRIES).toBe(1);
  });

  it('starts the client, checks the network of the node, then sends the request with 10 s and one retry', async () => {
    const { service, created } = setup();
    const result = await service.request({ command: 'account_info', account: 'rX' });
    expect(result).toEqual({ echoed: { command: 'account_info', account: 'rX' } });
    const { client } = created[0];
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls.map(([req]) => req.command)).toEqual(['server_info', 'account_info']);
    expect(client.request.mock.calls[1][1]).toEqual({ timeoutMs: 10_000, retries: 1 });
    // no api_version is ever added (both servers default to v1)
    expect(client.request.mock.calls.every(([req]) => !('api_version' in req))).toBe(true);
  });

  it('shares one start between concurrent first requests and between all later ones', async () => {
    const { service, factory, created } = setup();
    await Promise.all([
      service.request({ command: 'a' }),
      service.request({ command: 'b' }),
      service.request({ command: 'c' }),
    ]);
    await service.request({ command: 'd' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(created[0].client.start).toHaveBeenCalledTimes(1);
    expect(created[0].client.request.mock.calls.filter(([req]) => req.command === 'server_info')).toHaveLength(1);
  });

  it('lets the caller override the timeout and the retries (the codec definitions use a shorter wait)', async () => {
    const { service, created } = setup();
    await service.request({ command: 'server_definitions' }, { timeoutMs: 2000, retries: 0 });
    expect(created[0].client.request.mock.calls[1][1]).toEqual({ timeoutMs: 2000, retries: 0 });
  });

  it('rethrows a rippled error as it came, and keeps serving afterwards', async () => {
    const error = new RippledError('Account not found.', { error: 'actNotFound' });
    const client = fakeClient();
    const { service } = setup({ clients: [client] });
    await service.request({ command: 'ping' });
    client.request.mockRejectedValueOnce(error);
    await expect(service.request({ command: 'account_info' })).rejects.toBe(error);
    await expect(service.request({ command: 'ping' })).resolves.toBeDefined();
  });

  describe('network check (assertNetwork) on the first connect', () => {
    const info = (network_id?: number) => async (req: Record<string, unknown>) =>
      req.command === 'server_info' ? { info: { network_id, complete_ledgers: '1-2' } } : { ok: true };

    it('accepts a node of the configured network', async () => {
      await expect(
        setup({ clients: [fakeClient({ request: jest.fn(info(0)) })] }).service.request({ command: 'x' }),
      ).resolves.toEqual({ ok: true });
      const xahau = setup({ network: 'xahau', clients: [fakeClient({ request: jest.fn(info(21337)) })] });
      await expect(xahau.service.request({ command: 'x' })).resolves.toEqual({ ok: true });
    });

    it('refuses a node of another network, stops that client and tries a fresh one next time', async () => {
      const wrong = fakeClient({ request: jest.fn(info(21337)) });
      const right = fakeClient({ request: jest.fn(info(undefined)) });
      const { service, factory } = setup({ clients: [wrong, right] });
      await expect(service.request({ command: 'x' })).rejects.toThrow(
        'Node network_id 21337 does not match GH_NETWORK=xrpl',
      );
      expect(wrong.stop).toHaveBeenCalledTimes(1);
      expect(wrong.request.mock.calls.map(([req]) => req.command)).toEqual(['server_info']); // the caller's request was never sent
      await expect(service.request({ command: 'x' })).resolves.toEqual({ ok: true });
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('a Xahau API refuses an XRPL node', async () => {
      const { service } = setup({ network: 'xahau', clients: [fakeClient({ request: jest.fn(info(0)) })] });
      await expect(service.request({ command: 'x' })).rejects.toThrow('does not match GH_NETWORK=xahau');
    });
  });

  describe('when no node can be reached', () => {
    it('fails the request with NotConnectedError after the request timeout and keeps trying in the background', async () => {
      jest.useFakeTimers();
      const never = new Promise<void>(() => undefined);
      const client = fakeClient({ start: jest.fn(() => never) });
      const { service, factory } = setup({ clients: [client] });

      const first = service.request({ command: 'x' });
      const assertion = expect(first).rejects.toThrow(NotConnectedError);
      await jest.advanceTimersByTimeAsync(NODE_REQUEST_TIMEOUT_MS);
      await assertion;

      // The next request waits for the same connect attempt instead of opening another client.
      const second = service.request({ command: 'x' });
      const secondAssertion = expect(second).rejects.toThrow(NotConnectedError);
      await jest.advanceTimersByTimeAsync(NODE_REQUEST_TIMEOUT_MS);
      await secondAssertion;
      expect(factory).toHaveBeenCalledTimes(1);
      expect(client.start).toHaveBeenCalledTimes(1);
    });

    it('serves the requests once the node comes up', async () => {
      jest.useFakeTimers();
      let up!: () => void;
      const client = fakeClient({ start: jest.fn(() => new Promise<void>((resolve) => (up = resolve))) });
      const { service } = setup({ clients: [client] });
      const early = service.request({ command: 'x' });
      const earlyAssertion = expect(early).rejects.toThrow(NotConnectedError);
      await jest.advanceTimersByTimeAsync(NODE_REQUEST_TIMEOUT_MS);
      await earlyAssertion;

      up();
      await expect(service.request({ command: 'y' })).resolves.toEqual({ echoed: { command: 'y' } });
    });

    it('a start that fails outright is retried by the next request with a fresh client', async () => {
      const broken = fakeClient({ start: jest.fn().mockRejectedValue(new Error('boom')) });
      const { service, factory } = setup({ clients: [broken, fakeClient()] });
      await expect(service.request({ command: 'x' })).rejects.toThrow('boom');
      expect(broken.stop).toHaveBeenCalledTimes(1);
      await expect(service.request({ command: 'x' })).resolves.toBeDefined();
      expect(factory).toHaveBeenCalledTimes(2);
    });
  });

  describe('a rate-limited node (ruling R98)', () => {
    afterEach(() => nodeThrottle.clear());

    it('fails at once while every endpoint is paused, and makes no client for it', async () => {
      const { service, factory } = setup();
      nodeThrottle.pause('wss://a.example', new Error('rate limit: retry in ~60000ms'));
      nodeThrottle.pause('wss://b.example', new Error('rate limit: retry in ~30000ms'));
      const err = await service.request({ command: 'account_info' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NodeThrottledError);
      expect((err as NodeThrottledError).retryAfterMs).toBeGreaterThan(29_000);
      expect((err as NodeThrottledError).retryAfterMs).toBeLessThanOrEqual(30_250);
      expect(factory).not.toHaveBeenCalled();
    });

    it('serves while one endpoint is still usable', async () => {
      const { service } = setup();
      nodeThrottle.pause('wss://a.example', new Error('rate limit: retry in ~60000ms'));
      await expect(service.request({ command: 'x' })).resolves.toEqual({ echoed: { command: 'x' } });
    });
  });

  describe('shutdown', () => {
    it('registers the client stop with ShutdownSignals', () => {
      const { signals } = setup();
      expect(signals.register).toHaveBeenCalledWith('node-client', expect.any(Function));
    });

    it('stop() stops the client; later requests fail without a new connection', async () => {
      const { service, factory, created } = setup();
      await service.request({ command: 'x' });
      await service.stop();
      expect(created[0].client.stop).toHaveBeenCalledTimes(1);
      await service.stop(); // idempotent
      expect(created[0].client.stop).toHaveBeenCalledTimes(1);
      await expect(service.request({ command: 'x' })).rejects.toThrow('XrplService is stopped');
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('stopping before the first use connects to nothing', async () => {
      const { service, factory } = setup();
      await service.stop();
      expect(factory).not.toHaveBeenCalled();
      await expect(service.request({ command: 'x' })).rejects.toThrow('XrplService is stopped');
    });

    it('stopping while the first connect is pending stops that client and leaves no unhandled rejection', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        let reject!: (err: Error) => void;
        const client = fakeClient({ start: jest.fn(() => new Promise<void>((_, r) => (reject = r))) });
        const { service } = setup({ clients: [client] });
        const pending = service.request({ command: 'x' });
        const assertion = expect(pending).rejects.toThrow();
        await new Promise((resolve) => setImmediate(resolve));
        const stopping = service.stop();
        reject(new Error('NodeClient is stopped'));
        await stopping;
        await assertion;
        expect(client.stop).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('onModuleDestroy stops the client too (app.close() in tests)', async () => {
      const { service, created } = setup();
      await service.request({ command: 'x' });
      await service.onModuleDestroy();
      expect(created[0].client.stop).toHaveBeenCalledTimes(1);
    });
  });
});
