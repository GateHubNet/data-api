import { enabledWorkers, endpointHost, SyncerConfig } from './syncer.config';

interface Loaded {
  cfg: SyncerConfig;
  /** Arguments of every `process.exit` call (the toolbox ConfigService exits the process on invalid config). */
  exits: unknown[];
  /** Everything the ConfigService printed with console.error while validating. */
  errors: string;
}

const MINIMAL_ENV = { GH_NODE_ENDPOINTS: 'wss://s2.ripple.com' };

/**
 * Runs the real toolbox ConfigService pipeline (env -> class-transformer -> class-validator) against `env` in an
 * isolated module registry, because the ConfigService keeps its registry in a static field and exits on invalid input.
 */
async function loadConfig(env: Record<string, string>): Promise<Loaded> {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GH_') && key !== 'GH_ENV') delete process.env[key];
  }
  Object.assign(process.env, env);
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    let cfg: SyncerConfig | undefined;
    await jest.isolateModulesAsync(async () => {
      const mod = await import('./syncer.config');
      cfg = await mod.loadSyncerConfig();
    });
    return {
      cfg: cfg as unknown as SyncerConfig,
      exits: exit.mock.calls.map((call) => call[0]),
      errors: consoleError.mock.calls.map((call) => call.join(' ')).join('\n'),
    };
  } finally {
    exit.mockRestore();
    consoleError.mockRestore();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe('enabledWorkers', () => {
  const cfg = (workers: string) => ({ workers }) as SyncerConfig;

  it('parses list and rejects unknown names', () => {
    expect(enabledWorkers(cfg('ingest,validations,fee_stats,aggregator'))).toEqual(
      new Set(['ingest', 'validations', 'fee_stats', 'aggregator']),
    );
    expect(enabledWorkers(cfg(' ingest , fee_stats,,ingest '))).toEqual(new Set(['ingest', 'fee_stats']));
    expect(() => enabledWorkers(cfg('ingest,x'))).toThrow('Unknown worker "x"');
    expect(() => enabledWorkers(cfg('INGEST'))).toThrow('Unknown worker "INGEST"');
  });

  it('treats an empty list as no workers', () => {
    expect(enabledWorkers(cfg(''))).toEqual(new Set());
    expect(enabledWorkers(cfg(' , '))).toEqual(new Set());
  });
});

describe('SyncerConfig (GH_* environment)', () => {
  it('applies the documented defaults', async () => {
    const { cfg, exits } = await loadConfig(MINIMAL_ENV);
    expect(exits).toEqual([]);
    expect(cfg).toMatchObject({
      network: 'xrpl',
      nodeEndpoints: 'wss://s2.ripple.com',
      validationEndpoints: 'wss://s2.ripple.com',
      workers: 'ingest,validations,fee_stats,aggregator',
      ledgerFetchTimeoutMs: 120000,
      catchupConcurrency: 4,
      catchupFlushLedgers: 300,
      catchupFlushTxs: 100000,
      catchupFlushMs: 5000,
      runMigrationsOnBoot: false,
      httpApiPort: 3002,
      metriczPort: 3000,
      maxLagHealthy: 10,
    });
    expect(cfg.syncStartLedger).toBeUndefined();
  });

  it('reads every value from its GH_ variable and converts the types', async () => {
    const { cfg, exits } = await loadConfig({
      GH_NETWORK: 'xahau',
      GH_NODE_ENDPOINTS: 'wss://xahau.network, ws://10.0.0.5:6006',
      GH_VALIDATION_ENDPOINTS: 'ws://10.0.0.6:6006',
      GH_WORKERS: 'ingest,fee_stats',
      GH_SYNC_START_LEDGER: '1234567',
      GH_LEDGER_FETCH_TIMEOUT_MS: '45000',
      GH_CATCHUP_CONCURRENCY: '16',
      GH_CATCHUP_FLUSH_LEDGERS: '500',
      GH_CATCHUP_FLUSH_TXS: '250000',
      GH_CATCHUP_FLUSH_MS: '2500',
      GH_RUN_MIGRATIONS_ON_BOOT: 'true',
      GH_HTTP_API_PORT: '4002',
      GH_METRICZ_PORT: '4000',
      GH_MAX_LAG_HEALTHY: '0',
    });
    expect(exits).toEqual([]);
    expect(cfg).toMatchObject({
      network: 'xahau',
      nodeEndpoints: 'wss://xahau.network, ws://10.0.0.5:6006',
      validationEndpoints: 'ws://10.0.0.6:6006',
      workers: 'ingest,fee_stats',
      syncStartLedger: 1234567,
      ledgerFetchTimeoutMs: 45000,
      catchupConcurrency: 16,
      catchupFlushLedgers: 500,
      catchupFlushTxs: 250000,
      catchupFlushMs: 2500,
      runMigrationsOnBoot: true,
      httpApiPort: 4002,
      metriczPort: 4000,
      maxLagHealthy: 0,
    });
  });

  it('reads the string "false" as false (a plain Boolean() conversion would make it true)', async () => {
    const { cfg, exits } = await loadConfig({ ...MINIMAL_ENV, GH_RUN_MIGRATIONS_ON_BOOT: 'false' });
    expect(exits).toEqual([]);
    expect(cfg.runMigrationsOnBoot).toBe(false);
  });

  it('treats blank values as unset', async () => {
    const { cfg, exits } = await loadConfig({
      ...MINIMAL_ENV,
      GH_SYNC_START_LEDGER: '',
      GH_VALIDATION_ENDPOINTS: ' ',
      GH_CATCHUP_CONCURRENCY: '',
      GH_RUN_MIGRATIONS_ON_BOOT: '',
    });
    expect(exits).toEqual([]);
    expect(cfg.syncStartLedger).toBeUndefined();
    expect(cfg.validationEndpoints).toBe('wss://s2.ripple.com');
    expect(cfg.catchupConcurrency).toBe(4);
    expect(cfg.runMigrationsOnBoot).toBe(false);
  });

  it('allows an explicitly empty worker list', async () => {
    const { cfg, exits } = await loadConfig({ ...MINIMAL_ENV, GH_WORKERS: '' });
    expect(exits).toEqual([]);
    expect(cfg.workers).toBe('');
    expect(enabledWorkers(cfg)).toEqual(new Set());
  });

  it.each([
    'GH_LEDGER_FETCH_TIMEOUT_MS',
    'GH_CATCHUP_CONCURRENCY',
    'GH_CATCHUP_FLUSH_LEDGERS',
    'GH_CATCHUP_FLUSH_TXS',
    'GH_CATCHUP_FLUSH_MS',
    'GH_HTTP_API_PORT',
    'GH_METRICZ_PORT',
    'GH_SYNC_START_LEDGER',
  ])('rejects a %s that is not a positive integer', async (variable) => {
    for (const bad of ['0', '-5', 'abc', '1.5', '1e3', 'NaN']) {
      const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, [variable]: bad });
      expect({ bad, exits }).toEqual({ bad, exits: [1] });
      expect(errors).toContain(variable);
    }
  });

  it.each(['GH_HTTP_API_PORT', 'GH_METRICZ_PORT'])('rejects a %s above 65535', async (variable) => {
    const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, [variable]: '65536' });
    expect(exits).toEqual([1]);
    expect(errors).toContain(variable);
  });

  it('rejects a GH_MAX_LAG_HEALTHY that is not a non-negative integer', async () => {
    for (const bad of ['-1', 'abc', '2.5']) {
      const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, GH_MAX_LAG_HEALTHY: bad });
      expect({ bad, exits }).toEqual({ bad, exits: [1] });
      expect(errors).toContain('GH_MAX_LAG_HEALTHY');
    }
  });

  it('rejects an unknown network', async () => {
    const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, GH_NETWORK: 'bitcoin' });
    expect(exits).toEqual([1]);
    expect(errors).toContain('GH_NETWORK');
  });

  it('defaults the node endpoints to the public endpoint of the network, when unset or empty', async () => {
    for (const env of [{} as Record<string, string>, { GH_NODE_ENDPOINTS: ' ' }]) {
      const xrpl = await loadConfig(env);
      expect(xrpl.exits).toEqual([]);
      expect(xrpl.cfg).toMatchObject({
        nodeEndpoints: 'wss://s2.ripple.com,wss://xrplcluster.com',
        validationEndpoints: 'wss://s2.ripple.com,wss://xrplcluster.com',
      });
      const xahau = await loadConfig({ ...env, GH_NETWORK: 'xahau' });
      expect(xahau.exits).toEqual([]);
      expect(xahau.cfg).toMatchObject({
        nodeEndpoints: 'wss://xahau.network',
        validationEndpoints: 'wss://xahau.network',
      });
    }
  });

  it('keeps an explicit node endpoint list, and the validation endpoints follow it', async () => {
    const { cfg } = await loadConfig({ GH_NETWORK: 'xahau', GH_NODE_ENDPOINTS: 'ws://10.0.0.5:6006' });
    expect(cfg).toMatchObject({ nodeEndpoints: 'ws://10.0.0.5:6006', validationEndpoints: 'ws://10.0.0.5:6006' });
  });

  it('rejects endpoints that are not ws:// or wss:// URLs', async () => {
    const node = await loadConfig({ GH_NODE_ENDPOINTS: 'wss://ok.example, http://bad.example' });
    expect(node.exits).toEqual([1]);
    expect(node.errors).toContain('GH_NODE_ENDPOINTS');
    const validation = await loadConfig({ ...MINIMAL_ENV, GH_VALIDATION_ENDPOINTS: 'localhost:6006' });
    expect(validation.exits).toEqual([1]);
    expect(validation.errors).toContain('GH_VALIDATION_ENDPOINTS');
  });

  it('rejects unknown worker names', async () => {
    const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, GH_WORKERS: 'ingest,bogus' });
    expect(exits).toEqual([1]);
    expect(errors).toContain('Unknown worker \\"bogus\\"');
  });

  it('rejects a boolean that is neither true nor false', async () => {
    const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, GH_RUN_MIGRATIONS_ON_BOOT: 'maybe' });
    expect(exits).toEqual([1]);
    expect(errors).toContain('GH_RUN_MIGRATIONS_ON_BOOT');
  });

  it('can be loaded twice (main.ts and the AppModule both load it)', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, MINIMAL_ENV);
    try {
      await jest.isolateModulesAsync(async () => {
        const mod = await import('./syncer.config');
        const [a, b] = await Promise.all([mod.loadSyncerConfig(), mod.loadSyncerConfig()]);
        expect(b).toBe(a);
        expect(await mod.loadSyncerConfig()).toBe(a);
      });
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe('endpointHost', () => {
  it('keeps only protocol and host so credentials never reach the logs', () => {
    expect(endpointHost('wss://user:secret@node.example:443/path?token=abc')).toBe('wss://node.example');
    expect(endpointHost('ws://10.0.0.5:6006')).toBe('ws://10.0.0.5:6006');
    expect(endpointHost('not a url')).toBe('(invalid url)');
  });
});
