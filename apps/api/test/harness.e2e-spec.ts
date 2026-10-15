import { ClickHouseService, clickHouseConfigFromEnv } from '@gatehub/data-api-shared';
import { clickHouseUrl } from './e2e-env';
import { Harness, rippledError, startHarness } from './harness';
import { fixtureSource, fixtureTransactions } from './support/fixtures';

const controllers = async () => (await import('./harness-controllers')).HARNESS_CONTROLLERS;

async function count(h: Harness, table: string): Promise<number> {
  const [row] = await h.ch.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`);
  return Number(row.n);
}

/** A connection to the server's `default` database, to look at the harness databases from outside. */
async function onServer<T>(fn: (ch: ClickHouseService) => Promise<T>): Promise<T> {
  const ch = new ClickHouseService({
    ...clickHouseConfigFromEnv({ GH_CLICKHOUSE_URL: clickHouseUrl(), GH_CLICKHOUSE_DATABASE: 'default' }),
  });
  try {
    return await fn(ch);
  } finally {
    await ch.onModuleDestroy();
  }
}

const databaseExists = (name: string) =>
  onServer(async (ch) => {
    const rows = await ch.query('SELECT name FROM system.databases WHERE name = {name:String}', { name });
    return rows.length > 0;
  });

describe('startHarness', () => {
  describe('defaults', () => {
    let h: Harness;
    const stub = jest.fn();
    beforeAll(async () => {
      h = await startHarness({ controllers, xrplStub: stub });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('runs the xrpl network with an empty database and the test key', async () => {
      const res = await h.http().get('/v2/harness/network').set('X-API-Key', h.key);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ network: 'xrpl', native: 'XRP' });
      expect(h.key).toBe('test-key');
      expect(await count(h, 'ledgers')).toBe(0);
      expect(await count(h, 'transactions')).toBe(0);
    });

    it('migrated the schema into a fresh random database', async () => {
      expect(h.database).toMatch(/^api_e2e_[0-9a-f]{12}$/);
      const tables = await h.ch.query<{ name: string }>(
        'SELECT name FROM system.tables WHERE database = currentDatabase()',
      );
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['ledgers', 'transactions', 'tx_by_hash']));
    });

    it('gives the BinaryCodecService the stub: it asked for server_definitions at boot (no api_version)', () => {
      expect(stub).toHaveBeenCalled();
      expect(stub.mock.calls[0][0]).toEqual({ command: 'server_definitions' });
    });
  });

  describe('xrplStub', () => {
    let h: Harness;
    const stub = jest.fn(async (req: { command: string }) => {
      if (req.command === 'server_definitions') return undefined; // a node that does not answer it
      if (req.command === 'account_info') throw rippledError('actNotFound', 'Account not found.');
      if (req.command === 'boom') throw new Error('socket hang up');
      return { echoed: req };
    });
    beforeAll(async () => {
      h = await startHarness({ controllers, xrplStub: stub });
    });
    afterAll(async () => {
      await h?.close();
    });
    const node = (command: string) => h.http().get(`/v2/harness/node?command=${command}`).set('X-API-Key', h.key);

    it('overrides XrplService.request: the stub gets the request and its return value is the rippled result', async () => {
      const res = await node('fee');
      expect(res.body).toEqual({ result: 'success', node: { echoed: { command: 'fee' } } });
      expect(stub).toHaveBeenCalledWith({ command: 'fee' });
    });

    it('does not answer server_definitions: the codec falls back to the definitions bundled for the network', async () => {
      const res = await h.http().get('/v2/harness/network').set('X-API-Key', h.key);
      expect(res.body.definitions).toBe('profile');
    });

    it('a RippledError-like error reaches the caller as a RippledError of the app, as the NodeClient rethrows it', async () => {
      const res = await node('account_info');
      expect(res.body).toMatchObject({
        result: 'failed',
        isRippledError: true,
        name: 'RippledError',
        message: 'Account not found.',
        data: { error: 'actNotFound', error_message: 'Account not found.', status: 'error', type: 'response' },
      });
    });

    it('any other error passes as it is', async () => {
      const res = await node('boom');
      expect(res.body).toMatchObject({
        result: 'failed',
        isRippledError: false,
        name: 'Error',
        message: 'socket hang up',
      });
    });
  });

  describe('without a stub', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ controllers });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('never touches the network: a node request fails at once and the codec uses its fallback', async () => {
      const res = await h.http().get('/v2/harness/node?command=fee').set('X-API-Key', h.key);
      expect(res.body).toMatchObject({ result: 'failed', isRippledError: false });
      expect(res.body.message).toMatch(/xrplStub/);
      expect((await h.http().get('/v2/harness/network').set('X-API-Key', h.key)).body.definitions).toBe('profile');
    });
  });

  describe('seed ripple-mock', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ seed: 'ripple-mock', controllers });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('writes every mock ledger and transaction through the LedgerWriter', async () => {
      expect(await count(h, 'ledgers')).toBe(54);
      expect(await count(h, 'ledger_by_hash')).toBe(54);
      expect(await count(h, 'transactions')).toBe(fixtureTransactions('ripple-mock').length);
      expect(await count(h, 'tx_by_hash')).toBe(fixtureTransactions('ripple-mock').length);
      expect(await count(h, 'payments')).toBeGreaterThan(100);
    });

    it('stays on the xrpl network', async () => {
      const res = await h.http().get('/v2/harness/network').set('X-API-Key', h.key);
      expect(res.body).toMatchObject({ network: 'xrpl', native: 'XRP' });
    });
  });

  describe('seed xrpl-recorded', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ seed: 'xrpl-recorded', controllers });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('writes the recorded mainnet ledgers on the xrpl network, with the definitions bundled for it', async () => {
      const res = await h.http().get('/v2/harness/network').set('X-API-Key', h.key);
      expect(res.body).toMatchObject({ network: 'xrpl', native: 'XRP', definitions: 'profile' });
      expect(await count(h, 'ledgers')).toBe(fixtureSource('xrpl-recorded').list().length);
      expect(await count(h, 'transactions')).toBe(fixtureTransactions('xrpl-recorded').length);
    });
  });

  describe('network xahau + seed xahau-recorded', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ network: 'xahau', seed: 'xahau-recorded', controllers });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('runs the xahau profile and holds the recorded Xahau ledgers', async () => {
      const res = await h.http().get('/v2/harness/network').set('X-API-Key', h.key);
      expect(res.body).toMatchObject({ network: 'xahau', native: 'XAH', definitions: 'profile' });
      expect(await count(h, 'ledgers')).toBe(fixtureSource('xahau-recorded').list().length);
      expect(await count(h, 'transactions')).toBe(fixtureTransactions('xahau-recorded').length);
    });

    it('seeds with the native currency of the network (XAH, not XRP)', async () => {
      const natives = await h.ch.query<{ currency: string }>('SELECT DISTINCT currency FROM payments');
      expect(natives.map((r) => r.currency)).toContain('XAH');
      expect(natives.map((r) => r.currency)).not.toContain('XRP');
    });
  });

  describe('seed without a network', () => {
    it('takes the network of the seed', async () => {
      const h = await startHarness({ seed: 'xahau-recorded', controllers });
      try {
        const res = await h.http().get('/v2/harness/network').set('X-API-Key', h.key);
        expect(res.body.network).toBe('xahau');
      } finally {
        await h.close();
      }
    });

    it('refuses a seed of another network than the one asked for, before building anything', async () => {
      await expect(startHarness({ network: 'xrpl', seed: 'xahau-recorded' })).rejects.toThrow(/xahau-recorded.*xahau/);
      await expect(startHarness({ network: 'xahau', seed: 'ripple-mock' })).rejects.toThrow(/ripple-mock.*xrpl/);
    });
  });

  describe('isolation', () => {
    it('every harness gets its own database, and close() drops it', async () => {
      const a = await startHarness();
      const b = await startHarness();
      try {
        expect(a.database).not.toBe(b.database);
        await a.ch.insert('ledger_by_hash', [{ ledger_hash: 'AA', ledger_index: 1 }]);
        expect(await count(a, 'ledger_by_hash')).toBe(1);
        expect(await count(b, 'ledger_by_hash')).toBe(0);
        expect(await databaseExists(a.database)).toBe(true);
      } finally {
        await a.close();
        await b.close();
      }
      expect(await databaseExists(a.database)).toBe(false);
      expect(await databaseExists(b.database)).toBe(false);
    });
  });
});
