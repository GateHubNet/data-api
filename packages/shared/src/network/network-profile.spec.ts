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
        partialPaymentFixLedger: 0,
      });
    });

    it('defaults to xrpl when GH_NETWORK is unset', () => {
      expect(getNetworkProfile()).toMatchObject({
        name: 'xrpl',
        networkId: 0,
        nativeCurrency: 'XRP',
        defaultDatabase: 'xrpl',
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
    it('is undefined on xrpl (the codec ships its own definitions)', () => {
      expect(getNetworkProfile('xrpl').definitionsFallback()).toBeUndefined();
    });

    it('does not throw on xahau, whether or not the bundled JSON exists yet', () => {
      const definitions = getNetworkProfile('xahau').definitionsFallback();
      expect(definitions === undefined || typeof definitions === 'object').toBe(true);
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

    it('loads the bundled xahau markets (empty until populated)', () => {
      expect(loadMarketsConfig(getNetworkProfile('xahau'))).toEqual({
        version: 1,
        tradeMarkets: [],
        paymentCurrencies: [],
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
