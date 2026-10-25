import { getNetworkProfile, NETWORK_NAMES, networkChoiceText } from '@gatehub/data-api-shared/dist/network';
import {
  enabledWorkers,
  endpointHost,
  SyncerConfig,
  unlListCount,
  unlPublishersOf,
  unlThresholdOf,
  unlValidatorsOf,
} from './syncer.config';

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

/** The four validator keys of Xahau Testnet's fixed list: valid `n…` keys, in the order of its profile. */
const VALIDATOR_KEYS = getNetworkProfile('xahau-testnet').defaultUnlValidators.split(',');
const [K0, K1] = VALIDATOR_KEYS;

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
      unlValidators: '',
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
      accountRollupMinRows: 1000000,
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
      GH_ACCOUNT_ROLLUP_MIN_ROWS: '', // what the compose files pass when XRPL_ACCOUNT_ROLLUP_MIN_ROWS is empty
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
      accountRollupMinRows: 1000000,
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

  describe('GH_ACCOUNT_ROLLUP_MIN_ROWS', () => {
    it('is 1000000 unless it is set', async () => {
      const { cfg, exits } = await loadConfig(MINIMAL_ENV);
      expect(exits).toEqual([]);
      expect(cfg.accountRollupMinRows).toBe(1000000);
    });

    it('reads the digits it is given, and 0 turns the account_rollups job off', async () => {
      for (const [value, expected] of [
        ['0', 0],
        ['5', 5],
        ['2500000', 2500000],
      ] as const) {
        const { cfg, exits } = await loadConfig({ ...MINIMAL_ENV, GH_ACCOUNT_ROLLUP_MIN_ROWS: value });
        expect({ value, exits }).toEqual({ value, exits: [] });
        expect(cfg.accountRollupMinRows).toBe(expected);
      }
    });

    it('refuses what is not a non-negative integer, naming the variable', async () => {
      for (const bad of ['1.5', 'abc', '-1', '1e6']) {
        const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, GH_ACCOUNT_ROLLUP_MIN_ROWS: bad });
        expect({ bad, exits }).toEqual({ bad, exits: [1] });
        expect(errors).toContain('GH_ACCOUNT_ROLLUP_MIN_ROWS must be a non-negative integer');
      }
    });
  });

  it.each(NETWORK_NAMES)('takes GH_NETWORK=%s', async (name) => {
    const { cfg, exits } = await loadConfig({ ...MINIMAL_ENV, GH_NETWORK: name });
    expect(exits).toEqual([]);
    expect(cfg.network).toBe(name);
  });

  it('refuses another network, listing the four', async () => {
    const { exits, errors } = await loadConfig({ ...MINIMAL_ENV, GH_NETWORK: 'bitcoin' });
    expect(exits).toEqual([1]);
    expect(errors).toContain(networkChoiceText('GH_NETWORK'));
    expect(errors).toContain('GH_NETWORK must be one of xrpl, xahau, xrpl-testnet, xahau-testnet');
  });

  it("defaults GH_NODE_ENDPOINTS to the testnet's public servers", async () => {
    const xrplTestnet = await loadConfig({ GH_NETWORK: 'xrpl-testnet' });
    expect(xrplTestnet.exits).toEqual([]);
    expect(xrplTestnet.cfg.nodeEndpoints).toBe('wss://s.altnet.rippletest.net:51233,wss://testnet.xrpl-labs.com');
    const xahauTestnet = await loadConfig({ GH_NETWORK: 'xahau-testnet' });
    expect(xahauTestnet.exits).toEqual([]);
    expect(xahauTestnet.cfg.nodeEndpoints).toBe('wss://xahau-test.net');
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

    it.each(['default', 'DEFAULT', ' Default '])(
      "takes GH_UNL_PUBLISHERS=%j as the network's default",
      async (value) => {
        for (const network of NETWORK_NAMES) {
          const { cfg, exits } = await loadConfig({ GH_NETWORK: network, GH_UNL_PUBLISHERS: value });
          expect({ network, exits }).toEqual({ network, exits: [] });
          expect(cfg.unlPublishers).toBe(getNetworkProfile(network).defaultUnlPublishers);
        }
      },
    );

    it("gives XRPL Testnet its publisher and Xahau Testnet none, unset or as 'default'", async () => {
      const envs: Record<string, string>[] = [{}, { GH_UNL_PUBLISHERS: 'default' }];
      for (const env of envs) {
        const xrplTestnet = await loadConfig({ ...env, GH_NETWORK: 'xrpl-testnet' });
        expect(xrplTestnet.exits).toEqual([]);
        expect(unlPublishersOf(xrplTestnet.cfg).map((p) => p.id)).toEqual(['vl.altnet.rippletest.net']);
        const xahauTestnet = await loadConfig({ ...env, GH_NETWORK: 'xahau-testnet' });
        expect(xahauTestnet.exits).toEqual([]);
        expect(unlPublishersOf(xahauTestnet.cfg)).toEqual([]);
      }
    });

    it('reads default only as the whole value, not as part of a list', async () => {
      const { exits, errors } = await loadConfig({
        ...MINIMAL_ENV,
        GH_UNL_PUBLISHERS: `default,https://x.example=${publisherKey('1')}`,
      });
      expect(exits).toEqual([1]);
      expect(errors).toContain('GH_UNL_PUBLISHERS entry 1: must be url=key');
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

    it('refuses the id local, which names the fixed list', async () => {
      const { exits, errors } = await loadConfig({
        ...MINIMAL_ENV,
        GH_UNL_PUBLISHERS: `https://local=${publisherKey('1')}`,
      });
      expect(exits).toEqual([1]);
      // the ConfigService prints the failures as JSON, which escapes the quotes
      expect(errors).toContain('GH_UNL_PUBLISHERS entry 1: the id \\"local\\" is reserved');
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

  describe('GH_UNL_VALIDATORS', () => {
    it("is the network's fixed list when unset or default, none when empty, and itself when a list", async () => {
      const unset = await loadConfig({ GH_NETWORK: 'xahau-testnet' });
      expect(unset.exits).toEqual([]);
      expect(unset.cfg.unlValidators).toBe(getNetworkProfile('xahau-testnet').defaultUnlValidators);
      expect(unlValidatorsOf(unset.cfg)).toEqual(VALIDATOR_KEYS);

      for (const value of ['default', 'DEFAULT', ' Default ']) {
        const word = await loadConfig({ GH_NETWORK: 'xahau-testnet', GH_UNL_VALIDATORS: value });
        expect({ value, exits: word.exits }).toEqual({ value, exits: [] });
        expect(unlValidatorsOf(word.cfg)).toEqual(VALIDATOR_KEYS);
      }

      for (const value of ['', '  ']) {
        const empty = await loadConfig({ GH_NETWORK: 'xahau-testnet', GH_UNL_VALIDATORS: value });
        expect({ value, exits: empty.exits }).toEqual({ value, exits: [] });
        expect(empty.cfg.unlValidators).toBe('');
        expect(unlValidatorsOf(empty.cfg)).toEqual([]);
      }

      const list = await loadConfig({ GH_NETWORK: 'xahau-testnet', GH_UNL_VALIDATORS: ` ${K0}, ${K1} ` });
      expect(list.exits).toEqual([]);
      expect(list.cfg.unlValidators).toBe(`${K0}, ${K1}`);
      expect(unlValidatorsOf(list.cfg)).toEqual([K0, K1]);

      const xrpl = await loadConfig({ GH_NETWORK: 'xrpl' });
      expect(xrpl.exits).toEqual([]);
      expect(unlValidatorsOf(xrpl.cfg)).toEqual([]);
    });

    it('has no fixed list on the other networks, whether unset or default', async () => {
      const envs: Record<string, string>[] = [{}, { GH_UNL_VALIDATORS: 'default' }];
      for (const network of ['xrpl', 'xahau', 'xrpl-testnet']) {
        for (const env of envs) {
          const { cfg, exits } = await loadConfig({ ...env, GH_NETWORK: network });
          expect({ network, exits }).toEqual({ network, exits: [] });
          expect(unlValidatorsOf(cfg)).toEqual([]);
        }
      }
    });

    it('may be set on any network, beside its publishers', async () => {
      const { cfg, exits } = await loadConfig({ GH_NETWORK: 'xrpl', GH_UNL_VALIDATORS: K0 });
      expect(exits).toEqual([]);
      expect(unlValidatorsOf(cfg)).toEqual([K0]);
      expect(unlPublishersOf(cfg).map((p) => p.id)).toEqual(['vl.ripple.com', 'unl.xrplf.org']);
    });

    it.each([
      ['an entry that is not a key', `${K0},nonsense`, 'entry 2: must be a validator public key (n…)'],
      ['a publisher key', publisherKey('1'), 'entry 1: must be a validator public key (n…)'],
      ['a key listed twice', `${K0}, ${K0}`, 'entry 2: repeats a key'],
    ])('fails the boot, naming the variable, for %s', async (_what, value, why) => {
      const { exits, errors } = await loadConfig({ GH_NETWORK: 'xahau-testnet', GH_UNL_VALIDATORS: value });
      expect(exits).toEqual([1]);
      expect(errors).toContain(`GH_UNL_VALIDATORS ${why}`);
    });

    it('reads default only as the whole value, not as part of a list', async () => {
      const { exits, errors } = await loadConfig({ GH_NETWORK: 'xahau-testnet', GH_UNL_VALIDATORS: `default,${K0}` });
      expect(exits).toEqual([1]);
      expect(errors).toContain('GH_UNL_VALIDATORS entry 1: must be a validator public key (n…)');
    });

    it('is reported alone: the threshold is not checked against lists that cannot be read', async () => {
      const { exits, errors } = await loadConfig({
        ...MINIMAL_ENV,
        GH_UNL_VALIDATORS: 'nonsense',
        GH_UNL_THRESHOLD: '5',
      });
      expect(exits).toEqual([1]);
      expect(errors).toContain('GH_UNL_VALIDATORS entry 1');
      expect(errors).not.toContain('GH_UNL_THRESHOLD');
    });
  });

  describe('GH_UNL_THRESHOLD', () => {
    it('may be as large as the number of lists', async () => {
      const two = await loadConfig({ ...MINIMAL_ENV, GH_UNL_THRESHOLD: '2' }); // the two XRPL defaults
      expect(two.exits).toEqual([]);
      expect(two.cfg.unlThreshold).toBe(2);
      const none = await loadConfig({ ...MINIMAL_ENV, GH_UNL_PUBLISHERS: '', GH_UNL_THRESHOLD: '0' });
      expect(none.exits).toEqual([]);
      const withFixed = await loadConfig({ ...MINIMAL_ENV, GH_UNL_VALIDATORS: K0, GH_UNL_THRESHOLD: '3' }); // 2 + local
      expect(withFixed.exits).toEqual([]);
      expect(withFixed.cfg.unlThreshold).toBe(3);
    });

    it('fails the boot when it exceeds the number of lists', async () => {
      const three = await loadConfig({ ...MINIMAL_ENV, GH_UNL_THRESHOLD: '3' });
      expect(three.exits).toEqual([1]);
      expect(three.errors).toContain('GH_UNL_THRESHOLD must be between 0 and the number of lists (2)');
      const one = await loadConfig({ GH_NETWORK: 'xahau', GH_UNL_THRESHOLD: '2' });
      expect(one.exits).toEqual([1]);
      expect(one.errors).toContain('GH_UNL_THRESHOLD must be between 0 and the number of lists (1)');
      const none = await loadConfig({ ...MINIMAL_ENV, GH_UNL_PUBLISHERS: '', GH_UNL_THRESHOLD: '1' });
      expect(none.exits).toEqual([1]);
      expect(none.errors).toContain('GH_UNL_THRESHOLD must be between 0 and the number of lists (0)');
      const four = await loadConfig({ ...MINIMAL_ENV, GH_UNL_VALIDATORS: K0, GH_UNL_THRESHOLD: '4' });
      expect(four.exits).toEqual([1]);
      expect(four.errors).toContain('GH_UNL_THRESHOLD must be between 0 and the number of lists (3)');
    });

    it('counts the fixed list of Xahau Testnet as its one list', async () => {
      const fine = await loadConfig({ GH_NETWORK: 'xahau-testnet', GH_UNL_THRESHOLD: '1' });
      expect(fine.exits).toEqual([]);
      const two = await loadConfig({ GH_NETWORK: 'xahau-testnet', GH_UNL_THRESHOLD: '2' });
      expect(two.exits).toEqual([1]);
      expect(two.errors).toContain('GH_UNL_THRESHOLD must be between 0 and the number of lists (1)');
    });
  });

  it('counts the fixed list among the lists', async () => {
    const xahauTestnet = await loadConfig({ GH_NETWORK: 'xahau-testnet' });
    expect(unlListCount(xahauTestnet.cfg)).toBe(1);
    expect(unlThresholdOf(xahauTestnet.cfg)).toBe(1);
    const xrpl = await loadConfig({ GH_NETWORK: 'xrpl' });
    expect(unlListCount(xrpl.cfg)).toBe(2);
    expect(unlThresholdOf(xrpl.cfg)).toBe(1);
    const xrplWithFixed = await loadConfig({ GH_NETWORK: 'xrpl', GH_UNL_VALIDATORS: K0 });
    expect(unlListCount(xrplWithFixed.cfg)).toBe(3);
    expect(unlThresholdOf(xrplWithFixed.cfg)).toBe(2);
    const emptied = await loadConfig({ GH_NETWORK: 'xahau-testnet', GH_UNL_VALIDATORS: '' });
    expect(unlListCount(emptied.cfg)).toBe(0);
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

describe('unlPublishersOf, unlValidatorsOf, unlListCount and unlThresholdOf', () => {
  const list = (count: number) =>
    Array.from({ length: count }, (_, i) => `https://vl${i}.example=${publisherKey(String(i + 1))}`).join(',');

  it('parses the publishers of the setting', () => {
    expect(unlPublishersOf({ unlPublishers: list(2) }).map((p) => p.id)).toEqual(['vl0.example', 'vl1.example']);
    expect(unlPublishersOf({ unlPublishers: '' })).toEqual([]);
  });

  it('parses the fixed validators of the setting, in the order given', () => {
    expect(unlValidatorsOf({ unlValidators: `${K1}, ${K0}` })).toEqual([K1, K0]);
    expect(unlValidatorsOf({ unlValidators: '' })).toEqual([]);
    expect(() => unlValidatorsOf({ unlValidators: 'nonsense' })).toThrow(
      'GH_UNL_VALIDATORS entry 1: must be a validator public key (n…)',
    );
  });

  it('counts the publishers, plus one when the fixed list is not empty', () => {
    expect(unlListCount({ unlPublishers: '', unlValidators: '' })).toBe(0);
    expect(unlListCount({ unlPublishers: list(2), unlValidators: '' })).toBe(2);
    expect(unlListCount({ unlPublishers: '', unlValidators: K0 })).toBe(1);
    expect(unlListCount({ unlPublishers: list(2), unlValidators: VALIDATOR_KEYS.join(',') })).toBe(3);
  });

  it("takes rippled's rule for the threshold when it is 0, and the setting otherwise", () => {
    const of = (publishers: string, unlThreshold: number, unlValidators = '') =>
      unlThresholdOf({ unlPublishers: publishers, unlValidators, unlThreshold });
    expect(of(list(2), 0)).toBe(1);
    expect(of(list(1), 0)).toBe(1);
    expect(of(list(3), 0)).toBe(2);
    expect(of(list(5), 0)).toBe(3);
    expect(of(list(5), 5)).toBe(5);
    expect(of(list(2), 2)).toBe(2);
  });

  it("counts the fixed list for rippled's rule, as rippled counts its local list", () => {
    const of = (publishers: string, unlValidators: string) =>
      unlThresholdOf({ unlPublishers: publishers, unlValidators, unlThreshold: 0 });
    expect(of('', K0)).toBe(1); // Xahau Testnet: the fixed list alone
    expect(of(list(1), K0)).toBe(1);
    expect(of(list(2), K0)).toBe(2); // three lists: 2
    expect(of(list(4), K0)).toBe(3); // five lists: 3
    expect(unlThresholdOf({ unlPublishers: list(2), unlValidators: K0, unlThreshold: 3 })).toBe(3);
  });
});

describe('endpointHost', () => {
  it('keeps only protocol and host so credentials never reach the logs', () => {
    expect(endpointHost('wss://user:secret@node.example:443/path?token=abc')).toBe('wss://node.example');
    expect(endpointHost('ws://10.0.0.5:6006')).toBe('ws://10.0.0.5:6006');
    expect(endpointHost('not a url')).toBe('(invalid url)');
  });
});
