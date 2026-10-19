import { getNetworkProfile } from '@gatehub/data-api-shared/dist/network';
import { enabledWorkers, endpointHost, SyncerConfig, unlPublishersOf, unlThresholdOf } from './syncer.config';

interface Loaded {
  cfg: SyncerConfig;
  /** Arguments of every `process.exit` call (the toolbox ConfigService exits the process on invalid config). */
  exits: unknown[];
  /** Everything the ConfigService printed with console.error while validating. */
  errors: string;
}

const MINIMAL_ENV = { GH_NODE_ENDPOINTS: 'wss://s2.ripple.com' };

/** A syntactically valid publisher key (66 hex digits, `ED`...) that differs per `digit`. */
const publisherKey = (digit: string) => `ED${digit.repeat(64)}`;

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
    expect(enabledWorkers(cfg('ingest,validations,fee_stats,aggregator,validators'))).toEqual(
      new Set(['ingest', 'validations', 'fee_stats', 'aggregator', 'validators']),
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
      workers: 'ingest,validations,fee_stats,aggregator,validators',
      unlPublishers: getNetworkProfile('xrpl').defaultUnlPublishers,
      unlThreshold: 0,
      unlRefreshMs: 300000,
      domainVerification: true,
      domainRecheckMs: 21600000,
      domainFetchTimeoutMs: 10000,
      amendmentsConfig: '',
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
      GH_WORKERS: 'ingest,fee_stats,validators',
      GH_UNL_PUBLISHERS: ` https://vl.example=${publisherKey('a')} , https://unl.example=${publisherKey('B')} `,
      GH_UNL_THRESHOLD: '2',
      GH_UNL_REFRESH_MS: '60000',
      GH_DOMAIN_VERIFICATION: 'false',
      GH_DOMAIN_RECHECK_MS: '3600000',
      GH_DOMAIN_FETCH_TIMEOUT_MS: '5000',
      GH_AMENDMENTS_CONFIG: ' /etc/gatehub/amendments.json ',
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
      workers: 'ingest,fee_stats,validators',
      unlPublishers: `https://vl.example=${publisherKey('a')} , https://unl.example=${publisherKey('B')}`,
      unlThreshold: 2,
      unlRefreshMs: 60000,
      domainVerification: false,
      domainRecheckMs: 3600000,
      domainFetchTimeoutMs: 5000,
      amendmentsConfig: '/etc/gatehub/amendments.json',
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
      GH_UNL_THRESHOLD: ' ',
      GH_UNL_REFRESH_MS: '',
      GH_DOMAIN_VERIFICATION: '',
      GH_DOMAIN_RECHECK_MS: ' ',
      GH_DOMAIN_FETCH_TIMEOUT_MS: '',
      GH_AMENDMENTS_CONFIG: '',
    });
    expect(exits).toEqual([]);
    expect(cfg.syncStartLedger).toBeUndefined();
    expect(cfg.validationEndpoints).toBe('wss://s2.ripple.com');
    expect(cfg.catchupConcurrency).toBe(4);
    expect(cfg.runMigrationsOnBoot).toBe(false);
    expect(cfg).toMatchObject({
      unlThreshold: 0,
      unlRefreshMs: 300000,
      domainVerification: true,
      domainRecheckMs: 21600000,
      domainFetchTimeoutMs: 10000,
      amendmentsConfig: '',
    });
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
    'GH_UNL_REFRESH_MS',
    'GH_DOMAIN_RECHECK_MS',
    'GH_DOMAIN_FETCH_TIMEOUT_MS',
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

  it('rejects a GH_UNL_THRESHOLD that is not a non-negative integer', async () => {
    for (const bad of ['-1', 'abc', '1.5', '1e1']) {
      const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, GH_UNL_THRESHOLD: bad });
      expect({ bad, exits }).toEqual({ bad, exits: [1] });
      expect(errors).toContain('GH_UNL_THRESHOLD');
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
    for (const variable of ['GH_RUN_MIGRATIONS_ON_BOOT', 'GH_DOMAIN_VERIFICATION']) {
      const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, [variable]: 'maybe' });
      expect({ variable, exits }).toEqual({ variable, exits: [1] });
      expect(errors).toContain(`${variable} must be true or false`);
    }
  });

  it('reads GH_DOMAIN_VERIFICATION as true / false / 1 / 0, in any case', async () => {
    for (const [value, expected] of [
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['false', false],
      ['False', false],
      ['0', false],
    ] as const) {
      const { cfg, exits } = await loadConfig({ ...MINIMAL_ENV, GH_DOMAIN_VERIFICATION: value });
      expect({ value, exits }).toEqual({ value, exits: [] });
      expect(cfg.domainVerification).toBe(expected);
    }
  });

  describe('GH_UNL_PUBLISHERS', () => {
    it('defaults to the default publishers of the network, for xahau as for xrpl', async () => {
      for (const network of ['xrpl', 'xahau']) {
        const { cfg, exits } = await loadConfig({ GH_NETWORK: network });
        expect(exits).toEqual([]);
        expect(cfg.unlPublishers).toBe(getNetworkProfile(network).defaultUnlPublishers);
        expect(unlPublishersOf(cfg).map((p) => p.id)).toEqual(
          network === 'xrpl' ? ['vl.ripple.com', 'unl.xrplf.org'] : ['vl.xahau.org'],
        );
      }
    });

    it('means no lists when set but empty (blank counts as empty here, not as unset)', async () => {
      for (const value of ['', '  ']) {
        const { cfg, exits } = await loadConfig({ ...MINIMAL_ENV, GH_UNL_PUBLISHERS: value });
        expect({ value, exits }).toEqual({ value, exits: [] });
        expect(cfg.unlPublishers).toBe('');
        expect(unlPublishersOf(cfg)).toEqual([]);
      }
    });

    it('keeps an explicit list, whatever the network', async () => {
      const { cfg } = await loadConfig({
        GH_NETWORK: 'xahau',
        GH_UNL_PUBLISHERS: `https://vl.example=${publisherKey('1')}`,
      });
      expect(unlPublishersOf(cfg)).toEqual([
        { id: 'vl.example', url: 'https://vl.example', publicKey: publisherKey('1') },
      ]);
    });

    it.each([
      ['a URL that is not https', `http://x.example=${publisherKey('1')}`, 'entry 1: the URL must be an https:// URL'],
      [
        'a key of 64 digits',
        `https://x.example=${'A'.repeat(64)}`,
        'entry 1: the key must be 66 hex digits starting ED, 02 or 03',
      ],
      ['an entry without a key', 'https://x.example', 'entry 1: must be url=key'],
      [
        'a URL listed twice',
        `https://x.example=${publisherKey('1')},https://x.example/=${publisherKey('2')}`,
        'entry 2: repeats a URL',
      ],
      [
        'a key listed twice',
        `https://x.example=${publisherKey('1')},https://y.example=${publisherKey('1')}`,
        'entry 2: repeats a key',
      ],
    ])('fails the boot, naming the variable, for %s', async (_what, value, why) => {
      const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, GH_UNL_PUBLISHERS: value });
      expect(exits).toEqual([1]);
      expect(errors).toContain(`GH_UNL_PUBLISHERS ${why}`);
    });

    it('is reported alone: the threshold is not checked against publishers that cannot be read', async () => {
      const { exits, errors } = await loadConfig({
        ...MINIMAL_ENV,
        GH_UNL_PUBLISHERS: 'nonsense',
        GH_UNL_THRESHOLD: '5',
      });
      expect(exits).toEqual([1]);
      expect(errors).toContain('GH_UNL_PUBLISHERS entry 1');
      expect(errors).not.toContain('GH_UNL_THRESHOLD');
    });
  });

  describe('GH_UNL_THRESHOLD', () => {
    it('may be as large as the number of publishers', async () => {
      const two = await loadConfig({ ...MINIMAL_ENV, GH_UNL_THRESHOLD: '2' }); // the two XRPL defaults
      expect(two.exits).toEqual([]);
      expect(two.cfg.unlThreshold).toBe(2);
      const none = await loadConfig({ ...MINIMAL_ENV, GH_UNL_PUBLISHERS: '', GH_UNL_THRESHOLD: '0' });
      expect(none.exits).toEqual([]);
    });

    it('fails the boot when it exceeds the number of publishers', async () => {
      const three = await loadConfig({ ...MINIMAL_ENV, GH_UNL_THRESHOLD: '3' });
      expect(three.exits).toEqual([1]);
      expect(three.errors).toContain('GH_UNL_THRESHOLD must be between 0 and the number of publishers (2)');
      const one = await loadConfig({ GH_NETWORK: 'xahau', GH_UNL_THRESHOLD: '2' });
      expect(one.exits).toEqual([1]);
      expect(one.errors).toContain('GH_UNL_THRESHOLD must be between 0 and the number of publishers (1)');
      const none = await loadConfig({ ...MINIMAL_ENV, GH_UNL_PUBLISHERS: '', GH_UNL_THRESHOLD: '1' });
      expect(none.exits).toEqual([1]);
      expect(none.errors).toContain('GH_UNL_THRESHOLD must be between 0 and the number of publishers (0)');
    });
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

describe('unlPublishersOf and unlThresholdOf', () => {
  const list = (count: number) =>
    Array.from({ length: count }, (_, i) => `https://vl${i}.example=${publisherKey(String(i + 1))}`).join(',');

  it('parses the publishers of the setting', () => {
    expect(unlPublishersOf({ unlPublishers: list(2) }).map((p) => p.id)).toEqual(['vl0.example', 'vl1.example']);
    expect(unlPublishersOf({ unlPublishers: '' })).toEqual([]);
  });

  it("takes rippled's rule for the threshold when it is 0, and the setting otherwise", () => {
    expect(unlThresholdOf({ unlPublishers: list(2), unlThreshold: 0 })).toBe(1);
    expect(unlThresholdOf({ unlPublishers: list(1), unlThreshold: 0 })).toBe(1);
    expect(unlThresholdOf({ unlPublishers: list(3), unlThreshold: 0 })).toBe(2);
    expect(unlThresholdOf({ unlPublishers: list(5), unlThreshold: 0 })).toBe(3);
    expect(unlThresholdOf({ unlPublishers: list(5), unlThreshold: 5 })).toBe(5);
    expect(unlThresholdOf({ unlPublishers: list(2), unlThreshold: 2 })).toBe(2);
  });
});

describe('endpointHost', () => {
  it('keeps only protocol and host so credentials never reach the logs', () => {
    expect(endpointHost('wss://user:secret@node.example:443/path?token=abc')).toBe('wss://node.example');
    expect(endpointHost('ws://10.0.0.5:6006')).toBe('ws://10.0.0.5:6006');
    expect(endpointHost('not a url')).toBe('(invalid url)');
  });
});
