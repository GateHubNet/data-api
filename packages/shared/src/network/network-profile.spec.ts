import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getNetworkProfile, loadMarketsConfig } from './network-profile';

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
