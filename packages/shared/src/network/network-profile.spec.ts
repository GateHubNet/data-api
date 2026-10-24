import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertValidMarketsConfig } from '../aggregate/volume.job';
import { assertValidDatabaseName } from '../clickhouse/clickhouse.config';
import {
  getNetworkProfile,
  isNetworkName,
  loadMarketsConfig,
  NETWORK_NAMES,
  networkChoiceText,
  networkLogText,
  NetworkName,
  NetworkProfile,
} from './network-profile';

const XRPL_PUBLISHERS =
  'https://vl.ripple.com=ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734,' +
  'https://unl.xrplf.org=ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1';
const XAHAU_PUBLISHERS = 'https://vl.xahau.org=EDA46E9C39B1389894E690E58914DC1029602870370A0993E5B87C4A24EAF4A8E8';
const XRPL_TESTNET_PUBLISHERS =
  'https://vl.altnet.rippletest.net=ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860';
const XAHAU_TESTNET_VALIDATORS =
  'nHBoJCE3wPgkTcrNPMHyTJFQ2t77EyCAqcBRspFCpL6JhwCm94VZ,nHUVv4g47bFMySAZFUKVaXUYEmfiUExSoY4FzwXULNwJRzju4XnQ,' +
  'nHBvr8avSFTz4TFxZvvi4rEJZZtyqE3J6KAAcVWVtifsE7edPM7q,nHUH3Z8TRU57zetHbEPr1ynyrJhxQCwrJvNjr4j1SMjYADyW1WWe';

/** One row per network with every field of the profile table of the spec (section 1). */
const FOUR: [NetworkName, Omit<NetworkProfile, 'definitionsFallback'>][] = [
  [
    'xrpl',
    {
      name: 'xrpl',
      family: 'xrpl',
      kind: 'mainnet',
      displayName: 'XRP Ledger',
      networkId: 0,
      acceptedNodeNetworkIds: [undefined, 0],
      nativeCurrency: 'XRP',
      defaultDatabase: 'xrpl',
      defaultNodeEndpoints: ['wss://s2.ripple.com', 'wss://xrplcluster.com'],
      partialPaymentFixLedger: 4594094,
      software: 'rippled',
      tomlPath: '/.well-known/xrp-ledger.toml',
      defaultUnlPublishers: XRPL_PUBLISHERS,
      defaultUnlValidators: '',
      majorityHoldSeconds: 1_209_600,
      amendmentThresholdPercent: 80,
      flagInterval: 256,
    },
  ],
  [
    'xahau',
    {
      name: 'xahau',
      family: 'xahau',
      kind: 'mainnet',
      displayName: 'Xahau',
      networkId: 21337,
      acceptedNodeNetworkIds: [21337],
      nativeCurrency: 'XAH',
      defaultDatabase: 'xahau',
      defaultNodeEndpoints: ['wss://xahau.network'],
      partialPaymentFixLedger: 0,
      software: 'xahaud',
      tomlPath: '/.well-known/xahau.toml',
      defaultUnlPublishers: XAHAU_PUBLISHERS,
      defaultUnlValidators: '',
      majorityHoldSeconds: 432_000,
      amendmentThresholdPercent: 80,
      flagInterval: 256,
    },
  ],
  [
    'xrpl-testnet',
    {
      name: 'xrpl-testnet',
      family: 'xrpl',
      kind: 'testnet',
      displayName: 'XRPL Testnet',
      networkId: 1,
      acceptedNodeNetworkIds: [1],
      nativeCurrency: 'XRP',
      defaultDatabase: 'xrpl_testnet',
      defaultNodeEndpoints: ['wss://s.altnet.rippletest.net:51233', 'wss://testnet.xrpl-labs.com'],
      partialPaymentFixLedger: 0,
      software: 'rippled',
      tomlPath: '/.well-known/xrp-ledger.toml',
      defaultUnlPublishers: XRPL_TESTNET_PUBLISHERS,
      defaultUnlValidators: '',
      majorityHoldSeconds: 1_800,
      amendmentThresholdPercent: 80,
      flagInterval: 256,
    },
  ],
  [
    'xahau-testnet',
    {
      name: 'xahau-testnet',
      family: 'xahau',
      kind: 'testnet',
      displayName: 'Xahau Testnet',
      networkId: 21338,
      acceptedNodeNetworkIds: [21338],
      nativeCurrency: 'XAH',
      defaultDatabase: 'xahau_testnet',
      defaultNodeEndpoints: ['wss://xahau-test.net'],
      partialPaymentFixLedger: 0,
      software: 'xahaud',
      tomlPath: '/.well-known/xahau.toml',
      defaultUnlPublishers: '',
      defaultUnlValidators: XAHAU_TESTNET_VALIDATORS,
      majorityHoldSeconds: 432_000,
      amendmentThresholdPercent: 80,
      flagInterval: 256,
    },
  ],
];

describe('network profiles', () => {
  const saved = { GH_NETWORK: process.env.GH_NETWORK, GH_MARKETS_CONFIG: process.env.GH_MARKETS_CONFIG };

  beforeEach(() => {
    delete process.env.GH_NETWORK;
    delete process.env.GH_MARKETS_CONFIG;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('getNetworkProfile', () => {
    it('returns the xahau profile', () => {
      expect(getNetworkProfile('xahau')).toMatchObject({
        name: 'xahau',
        networkId: 21337,
        nativeCurrency: 'XAH',
        defaultDatabase: 'xahau',
        defaultNodeEndpoints: ['wss://xahau.network'],
        partialPaymentFixLedger: 0,
      });
    });

    it('has the public node endpoints of each network as the default for GH_NODE_ENDPOINTS', () => {
      // Ruling R98: Ripple's full-history server first (it did not throttle the verification run), the cluster second.
      expect(getNetworkProfile('xrpl').defaultNodeEndpoints).toEqual(['wss://s2.ripple.com', 'wss://xrplcluster.com']);
      expect(getNetworkProfile('xahau').defaultNodeEndpoints).toEqual(['wss://xahau.network']);
    });

    it('lists the four networks in their order', () =>
      expect(NETWORK_NAMES).toEqual(['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet']));

    it.each(FOUR)('has the §1 values of %s', (name, values) => {
      const profile = getNetworkProfile(name);
      expect(profile).toMatchObject(values);
      expect(profile.acceptedNodeNetworkIds).toEqual(values.acceptedNodeNetworkIds);
    });

    it('gives every network a CTID id of its own', () =>
      expect(new Set(NETWORK_NAMES.map((n) => getNetworkProfile(n).networkId)).size).toBe(4));

    it('names a valid database of its own for every network', () => {
      const names = NETWORK_NAMES.map((n) => getNetworkProfile(n).defaultDatabase);
      for (const name of names) expect(assertValidDatabaseName(name)).toBe(name);
      expect(new Set(names).size).toBe(4);
    });

    it('throws on a network it does not know', () =>
      expect(() => getNetworkProfile('xrpl-devnet')).toThrow('Unknown GH_NETWORK "xrpl-devnet"'));

    it('reads GH_NETWORK for a testnet', () => {
      process.env.GH_NETWORK = 'xahau-testnet';
      expect(getNetworkProfile().name).toBe('xahau-testnet');
    });

    it('has the validator and amendment values of each network', () => {
      expect(getNetworkProfile('xrpl')).toMatchObject({
        software: 'rippled',
        tomlPath: '/.well-known/xrp-ledger.toml',
        defaultUnlPublishers: XRPL_PUBLISHERS,
        majorityHoldSeconds: 1_209_600,
        amendmentThresholdPercent: 80,
        flagInterval: 256,
      });
      expect(getNetworkProfile('xahau')).toMatchObject({
        software: 'xahaud',
        tomlPath: '/.well-known/xahau.toml',
        defaultUnlPublishers: XAHAU_PUBLISHERS,
        majorityHoldSeconds: 432_000,
        amendmentThresholdPercent: 80,
        flagInterval: 256,
      });
    });

    it('defaults to xrpl when GH_NETWORK is unset', () => {
      expect(getNetworkProfile()).toMatchObject({
        name: 'xrpl',
        networkId: 0,
        nativeCurrency: 'XRP',
        defaultDatabase: 'xrpl',
        defaultNodeEndpoints: ['wss://s2.ripple.com', 'wss://xrplcluster.com'],
        partialPaymentFixLedger: 4594094,
      });
    });

    it('reads GH_NETWORK when no name is given', () => {
      process.env.GH_NETWORK = 'xahau';
      expect(getNetworkProfile().name).toBe('xahau');
    });

    it('treats an empty GH_NETWORK as unset', () => {
      process.env.GH_NETWORK = '';
      expect(getNetworkProfile().name).toBe('xrpl');
    });

    it('prefers an explicit name over GH_NETWORK', () => {
      process.env.GH_NETWORK = 'xahau';
      expect(getNetworkProfile('xrpl').name).toBe('xrpl');
    });

    it('throws on an unknown network', () => {
      expect(() => getNetworkProfile('foo')).toThrow('Unknown GH_NETWORK "foo"');
    });

    it('does not resolve inherited object keys as networks', () => {
      expect(() => getNetworkProfile('constructor')).toThrow('Unknown GH_NETWORK "constructor"');
      expect(() => getNetworkProfile('__proto__')).toThrow('Unknown GH_NETWORK "__proto__"');
    });
  });

  describe('isNetworkName, networkChoiceText and networkLogText', () => {
    it('tells a network name from anything else', () => {
      expect(NETWORK_NAMES.every(isNetworkName)).toBe(true);
      expect(['bitcoin', 'XRPL', '', 'constructor', undefined].some(isNetworkName)).toBe(false);
    });

    it('words the choice and the boot line', () => {
      expect(networkChoiceText('GH_NETWORK')).toBe(
        'GH_NETWORK must be one of xrpl, xahau, xrpl-testnet, xahau-testnet',
      );
      expect(networkLogText(getNetworkProfile('xrpl'))).toBe('network=xrpl');
      expect(networkLogText(getNetworkProfile('xahau-testnet'))).toBe('network=xahau-testnet kind=testnet');
    });
  });

  describe('definitionsFallback', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gh-definitions-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads and parses the definitions file on xrpl too', () => {
      const file = join(dir, 'xrpl.json');
      const definitions = { TRANSACTION_TYPES: { Payment: 0 }, FIELDS: [] };
      writeFileSync(file, JSON.stringify(definitions));
      expect(getNetworkProfile('xrpl').definitionsFallback(file)).toEqual(definitions);
    });

    it('is undefined on xrpl when the definitions file is missing', () => {
      expect(getNetworkProfile('xrpl').definitionsFallback(join(dir, 'missing.json'))).toBeUndefined();
    });

    it('returns the bundled xrpl server_definitions from the default path', () => {
      const definitions = getNetworkProfile('xrpl').definitionsFallback() as {
        TYPES: Record<string, number>;
        TRANSACTION_TYPES: Record<string, number>;
        FIELDS: unknown[];
      };
      expect(definitions).toEqual(
        expect.objectContaining({
          TYPES: expect.any(Object),
          FIELDS: expect.any(Array),
          TRANSACTION_TYPES: expect.any(Object),
          TRANSACTION_RESULTS: expect.any(Object),
          LEDGER_ENTRY_TYPES: expect.any(Object),
        }),
      );
      // Types the codec of a few years ago did not know prove this is a current XRPL file, and not the Xahau one.
      expect(definitions.TRANSACTION_TYPES).toEqual(
        expect.objectContaining({
          OracleSet: expect.any(Number),
          Batch: expect.any(Number),
          VaultCreate: expect.any(Number),
        }),
      );
      expect(definitions.TRANSACTION_TYPES).not.toHaveProperty('ClaimReward');
      expect(definitions.TYPES).toEqual(
        expect.objectContaining({ Hash192: expect.any(Number), Number: expect.any(Number), Int32: expect.any(Number) }),
      );
    });

    it('reads and parses the definitions file on xahau', () => {
      const file = join(dir, 'xahau.json');
      const definitions = { TRANSACTION_TYPES: { Payment: 0, Import: 97 }, FIELDS: [] };
      writeFileSync(file, JSON.stringify(definitions));
      expect(getNetworkProfile('xahau').definitionsFallback(file)).toEqual(definitions);
    });

    it('is undefined on xahau when the definitions file is missing', () => {
      expect(getNetworkProfile('xahau').definitionsFallback(join(dir, 'missing.json'))).toBeUndefined();
    });

    it('returns the bundled xahau server_definitions from the default path', () => {
      const definitions = getNetworkProfile('xahau').definitionsFallback();
      expect(definitions).toBeDefined();
      expect(definitions).toEqual(
        expect.objectContaining({
          TYPES: expect.any(Object),
          FIELDS: expect.any(Array),
          TRANSACTION_TYPES: expect.any(Object),
        }),
      );
      // Xahau-only transaction types prove this is the Xahau file and not the XRPL definitions.
      expect((definitions as { TRANSACTION_TYPES: Record<string, number> }).TRANSACTION_TYPES).toEqual(
        expect.objectContaining({ Import: expect.any(Number), ClaimReward: expect.any(Number) }),
      );
    });
  });

  describe('loadMarketsConfig', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gh-markets-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('loads the bundled xrpl markets', () => {
      const markets = loadMarketsConfig(getNetworkProfile('xrpl'));
      expect(markets.version).toBe(1);
      expect(markets.tradeMarkets).toHaveLength(5);
      expect(markets.paymentCurrencies).toHaveLength(5);
      for (const market of markets.tradeMarkets) {
        expect(market.counter).toEqual({ currency: 'XRP' });
        expect(market.base.issuer).toMatch(/^r/);
      }
      expect(markets.tradeMarkets.map((m) => m.base)).toEqual(markets.paymentCurrencies);
    });

    it('loads the bundled xahau markets: version 3, derived from a sample, without the XXX test token (ruling R104)', () => {
      const evr = { currency: 'EVR', issuer: 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8' };
      expect(loadMarketsConfig(getNetworkProfile('xahau'))).toEqual({
        version: 3,
        tradeMarkets: [{ base: evr, counter: { currency: 'XAH' } }],
        paymentCurrencies: [
          evr,
          { currency: '4555525100000000000000000000000000000000', issuer: 'rDk1xiArDMjDqnrR2yWypwQAKg4mKnQYvs' },
          { currency: 'RVN', issuer: 'rodinGM9xiKq7rDDnLPyieREkqGJ6zKyb' },
        ],
      });
    });

    it.each(['xrpl-testnet', 'xahau-testnet'])('ships empty markets for %s, which the volume jobs accept', (name) => {
      const markets = loadMarketsConfig(getNetworkProfile(name));
      expect(markets).toEqual({ version: 1, tradeMarkets: [], paymentCurrencies: [] });
      expect(() => assertValidMarketsConfig(markets, getNetworkProfile(name).nativeCurrency)).not.toThrow();
    });

    it('honours the GH_MARKETS_CONFIG env path', () => {
      const file = join(dir, 'markets.json');
      writeFileSync(file, JSON.stringify({ version: 7, tradeMarkets: [], paymentCurrencies: [{ currency: 'USD' }] }));
      process.env.GH_MARKETS_CONFIG = file;
      expect(loadMarketsConfig(getNetworkProfile('xrpl'))).toEqual({
        version: 7,
        tradeMarkets: [],
        paymentCurrencies: [{ currency: 'USD' }],
      });
    });

    it('prefers an explicit path over GH_MARKETS_CONFIG', () => {
      const envFile = join(dir, 'env.json');
      const argFile = join(dir, 'arg.json');
      writeFileSync(envFile, JSON.stringify({ version: 1, tradeMarkets: [], paymentCurrencies: [] }));
      writeFileSync(argFile, JSON.stringify({ version: 2, tradeMarkets: [], paymentCurrencies: [] }));
      process.env.GH_MARKETS_CONFIG = envFile;
      expect(loadMarketsConfig(getNetworkProfile('xrpl'), argFile).version).toBe(2);
    });

    it('rejects a file that is not a markets config', () => {
      const file = join(dir, 'bad.json');
      writeFileSync(file, JSON.stringify({ version: 1 }));
      expect(() => loadMarketsConfig(getNetworkProfile('xrpl'), file)).toThrow(/Invalid markets config/);
    });
  });
});
