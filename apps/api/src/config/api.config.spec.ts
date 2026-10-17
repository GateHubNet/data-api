import { ApiConfig, apiKeysOf, corsOriginOf, endpointList, rateLimitKeysOf } from './api.config';

interface Loaded {
  cfg: ApiConfig;
  /** Arguments of every `process.exit` call (the toolbox ConfigService exits the process on invalid config). */
  exits: unknown[];
  /** Everything the ConfigService printed with console.error while validating. */
  errors: string;
}

/**
 * Runs the real toolbox ConfigService pipeline (env -> class-transformer -> class-validator) against `env` in an
 * isolated module registry, because the ConfigService keeps its registry in a static field and exits on invalid input.
 */
async function loadConfig(env: Record<string, string> = {}): Promise<Loaded> {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GH_') && key !== 'GH_ENV') delete process.env[key];
  }
  Object.assign(process.env, env);
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    let cfg: ApiConfig | undefined;
    await jest.isolateModulesAsync(async () => {
      const mod = await import('./api.config');
      cfg = await mod.loadApiConfig();
    });
    return {
      cfg: cfg as unknown as ApiConfig,
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

describe('ApiConfig (GH_* environment)', () => {
  it('applies the documented defaults without any variable', async () => {
    const { cfg, exits } = await loadConfig();
    expect(exits).toEqual([]);
    expect(cfg).toMatchObject({
      network: 'xrpl',
      nodeEndpoints: 'wss://s2.ripple.com,wss://xrplcluster.com',
      apiKeys: '',
      httpApiPort: 3001,
      metriczPort: 3000,
      corsOrigins: '',
      rateLimit: 600,
      rateLimitWindow: 60,
      rateLimitKeys: '',
      liveCacheTtlMs: 10000,
      txCacheSize: 20000,
      trustProxyHops: 1,
      // key-gated answers: private, so a shared cache does not serve one client's answer to another (R109)
      cacheControl: 'private, max-age=60',
    });
  });

  it('reads every value from its GH_ variable and converts the types', async () => {
    const { cfg, exits } = await loadConfig({
      GH_NETWORK: 'xahau',
      GH_NODE_ENDPOINTS: 'wss://xahau.network, ws://10.0.0.5:6006',
      GH_API_KEYS: ' key-a , key-b ',
      GH_HTTP_API_PORT: '4001',
      GH_METRICZ_PORT: '4000',
      GH_CORS_ORIGINS: 'https://app.example.com,http://localhost:3000',
      GH_RATE_LIMIT: '50',
      GH_RATE_LIMIT_WINDOW: '10',
      GH_RATE_LIMIT_KEYS: 'a=5',
      GH_LIVE_CACHE_TTL_MS: '0',
      GH_TX_CACHE_SIZE: '0',
      GH_TRUST_PROXY_HOPS: '0',
      GH_CACHE_CONTROL: 'public, max-age=5',
    });
    expect(exits).toEqual([]);
    expect(cfg).toMatchObject({
      network: 'xahau',
      nodeEndpoints: 'wss://xahau.network, ws://10.0.0.5:6006',
      apiKeys: 'key-a , key-b',
      httpApiPort: 4001,
      metriczPort: 4000,
      corsOrigins: 'https://app.example.com,http://localhost:3000',
      rateLimit: 50,
      rateLimitWindow: 10,
      rateLimitKeys: 'a=5',
      liveCacheTtlMs: 0,
      txCacheSize: 0,
      trustProxyHops: 0,
      cacheControl: 'public, max-age=5',
    });
  });

  it('takes the default for a blank value, except where empty means "off"', async () => {
    const { cfg, exits } = await loadConfig({
      GH_NETWORK: ' ',
      GH_NODE_ENDPOINTS: '',
      GH_HTTP_API_PORT: '',
      GH_RATE_LIMIT: '  ',
      GH_API_KEYS: '',
      GH_CORS_ORIGINS: '',
      GH_CACHE_CONTROL: '',
    });
    expect(exits).toEqual([]);
    expect(cfg).toMatchObject({
      network: 'xrpl',
      nodeEndpoints: 'wss://s2.ripple.com,wss://xrplcluster.com',
      httpApiPort: 3001,
      rateLimit: 600,
      apiKeys: '',
      corsOrigins: '',
      cacheControl: '', // set to empty: no Cache-Control at all
    });
  });

  it('defaults GH_NODE_ENDPOINTS to the public endpoint of the network, when unset or empty', async () => {
    expect((await loadConfig({ GH_NETWORK: 'xahau' })).cfg.nodeEndpoints).toBe('wss://xahau.network');
    expect((await loadConfig({ GH_NETWORK: 'xahau', GH_NODE_ENDPOINTS: ' ' })).cfg.nodeEndpoints).toBe(
      'wss://xahau.network',
    );
    expect((await loadConfig({ GH_NETWORK: 'xrpl' })).cfg.nodeEndpoints).toBe(
      'wss://s2.ripple.com,wss://xrplcluster.com',
    );
    expect((await loadConfig({ GH_NETWORK: 'xahau', GH_NODE_ENDPOINTS: 'ws://10.0.0.5:6006' })).cfg.nodeEndpoints).toBe(
      'ws://10.0.0.5:6006',
    );
  });

  it('reports an unknown network once, instead of failing on its endpoint default', async () => {
    const { exits, errors } = await loadConfig({ GH_NETWORK: 'bitcoin' });
    expect(exits).toEqual([1]);
    expect(errors).toContain('GH_NETWORK must be xrpl or xahau');
    expect(errors).not.toContain('GH_NODE_ENDPOINTS');
  });

  it('allows * as the CORS origin', async () => {
    const { cfg, exits } = await loadConfig({ GH_CORS_ORIGINS: '*' });
    expect(exits).toEqual([]);
    expect(cfg.corsOrigins).toBe('*');
  });

  it.each([
    ['GH_NETWORK', 'bitcoin', 'GH_NETWORK must be xrpl or xahau'],
    [
      'GH_NODE_ENDPOINTS',
      'https://example.com',
      'GH_NODE_ENDPOINTS must be a comma separated list of ws:// or wss:// URLs',
    ],
    [
      'GH_NODE_ENDPOINTS',
      'wss://a.example,nope',
      'GH_NODE_ENDPOINTS must be a comma separated list of ws:// or wss:// URLs',
    ],
    ['GH_HTTP_API_PORT', '0', 'GH_HTTP_API_PORT must be an integer between 1 and 65535'],
    ['GH_HTTP_API_PORT', '70000', 'GH_HTTP_API_PORT must be an integer between 1 and 65535'],
    ['GH_HTTP_API_PORT', '30.5', 'GH_HTTP_API_PORT must be an integer between 1 and 65535'],
    ['GH_METRICZ_PORT', 'abc', 'GH_METRICZ_PORT must be an integer between 1 and 65535'],
    [
      'GH_CORS_ORIGINS',
      'example.com',
      'GH_CORS_ORIGINS must be * or a comma separated list of http:// or https:// origins',
    ],
    [
      'GH_CORS_ORIGINS',
      'https://a.example,*',
      'GH_CORS_ORIGINS must be * or a comma separated list of http:// or https:// origins',
    ],
    ['GH_RATE_LIMIT', '0', 'GH_RATE_LIMIT must be a positive integer'],
    ['GH_RATE_LIMIT', '1e3', 'GH_RATE_LIMIT must be a positive integer'],
    ['GH_RATE_LIMIT_WINDOW', '-5', 'GH_RATE_LIMIT_WINDOW must be a positive integer'],
    ['GH_LIVE_CACHE_TTL_MS', '-1', 'GH_LIVE_CACHE_TTL_MS must be a non-negative integer'],
    ['GH_TX_CACHE_SIZE', '-1', 'GH_TX_CACHE_SIZE must be a non-negative integer'],
    ['GH_TX_CACHE_SIZE', 'lots', 'GH_TX_CACHE_SIZE must be a non-negative integer'],
    ['GH_TRUST_PROXY_HOPS', 'one', 'GH_TRUST_PROXY_HOPS must be a non-negative integer'],
    ['GH_CACHE_CONTROL', 'public\nmax-age=60', 'GH_CACHE_CONTROL must be printable ASCII'],
  ])('rejects %s=%j, naming the variable', async (name, value, message) => {
    const { exits, errors } = await loadConfig({ [name]: value });
    expect(exits).toEqual([1]);
    expect(errors).toContain(message);
  });
});

describe('apiKeysOf', () => {
  it('splits and trims the comma list', () => {
    expect(apiKeysOf({ apiKeys: ' a , b,,c ' }, { NODE_ENV: 'production' })).toEqual(['a', 'b', 'c']);
  });

  it('allows an empty list outside production (authentication off)', () => {
    expect(apiKeysOf({ apiKeys: '' }, { NODE_ENV: 'development' })).toEqual([]);
    expect(apiKeysOf({ apiKeys: '' }, { NODE_ENV: 'test' })).toEqual([]);
    expect(apiKeysOf({ apiKeys: '' }, {})).toEqual([]);
  });

  it('throws in production when the list is empty or only separators', () => {
    expect(() => apiKeysOf({ apiKeys: '' }, { NODE_ENV: 'production' })).toThrow(
      'GH_API_KEYS must be set in production',
    );
    expect(() => apiKeysOf({ apiKeys: ' , ,' }, { NODE_ENV: 'production' })).toThrow(
      'GH_API_KEYS must be set in production',
    );
  });

  const PLACEHOLDER =
    'GH_API_KEYS contains a placeholder key (dev-api-key or change-me...): set real keys in production';

  it.each([
    'dev-api-key',
    'change-me',
    'change-me-key-1',
    'Change-Me-Key-2',
    'abc,dev-api-key',
    'real-key-1, change-me-key-2 ,real-key-3',
  ])('throws in production when %s contains a placeholder key', (apiKeys) => {
    expect(() => apiKeysOf({ apiKeys }, { NODE_ENV: 'production' })).toThrow(PLACEHOLDER);
  });

  it('does not echo the keys in the error', () => {
    expect(() => apiKeysOf({ apiKeys: 'real-secret-key,change-me-x' }, { NODE_ENV: 'production' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('real-secret-key') }),
    );
  });

  it('accepts keys that merely contain or resemble a placeholder in production', () => {
    expect(
      apiKeysOf({ apiKeys: 'my-dev-api-key,xchange-me,change_me,dev-api-keys' }, { NODE_ENV: 'production' }),
    ).toEqual(['my-dev-api-key', 'xchange-me', 'change_me', 'dev-api-keys']);
  });

  it('allows the placeholder keys outside production', () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      expect(apiKeysOf({ apiKeys: 'dev-api-key,change-me-key-1' }, { NODE_ENV })).toEqual([
        'dev-api-key',
        'change-me-key-1',
      ]);
    }
  });

  it('reads NODE_ENV from the process by default', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => apiKeysOf({ apiKeys: '' })).toThrow('GH_API_KEYS must be set in production');
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('rateLimitKeysOf', () => {
  const of = (rateLimitKeys: string, apiKeys = 'a,b,abc==') => rateLimitKeysOf({ apiKeys, rateLimitKeys });

  it('is empty for an empty setting', () => expect(of('')).toEqual(new Map()));

  it('parses pairs and trims', () =>
    expect(of(' a = 5 , b=60000 ')).toEqual(
      new Map([
        ['a', 5],
        ['b', 60000],
      ]),
    ));

  it('accepts the largest safe integer', () =>
    expect(of('a=9007199254740991')).toEqual(new Map([['a', Number.MAX_SAFE_INTEGER]])));

  it('splits at the last =', () => expect(of('abc===7')).toEqual(new Map([['abc==', 7]])));

  it.each([
    ['a', 'GH_RATE_LIMIT_KEYS entry 1 must be key=limit'],
    ['=5', 'GH_RATE_LIMIT_KEYS entry 1 must be key=limit'],
    ['a=5,b=0', 'GH_RATE_LIMIT_KEYS entry 2 must have a positive whole limit'],
    ['a=-1', 'GH_RATE_LIMIT_KEYS entry 1 must have a positive whole limit'],
    ['a=1.5', 'GH_RATE_LIMIT_KEYS entry 1 must have a positive whole limit'],
    ['a=abc', 'GH_RATE_LIMIT_KEYS entry 1 must have a positive whole limit'],
    ['a=5,zz=5', 'GH_RATE_LIMIT_KEYS entry 2 names a key that is not in GH_API_KEYS'],
    ['a=5,a=6', 'GH_RATE_LIMIT_KEYS entry 2 repeats a key'],
    ['a=9007199254740992', 'GH_RATE_LIMIT_KEYS entry 1 must have a positive whole limit'],
    ['a=9999999999999999', 'GH_RATE_LIMIT_KEYS entry 1 must have a positive whole limit'],
  ])('rejects %s', (value, message) => expect(() => of(value)).toThrow(message));

  it('rejects a limit of 309 digits (it reads as Infinity)', () =>
    expect(() => of(`a=${'9'.repeat(309)}`)).toThrow('GH_RATE_LIMIT_KEYS entry 1 must have a positive whole limit'));

  it('needs GH_API_KEYS', () => expect(() => of('a=5', '')).toThrow('GH_RATE_LIMIT_KEYS needs GH_API_KEYS'));

  it('never puts a key in a message', () => {
    for (const v of ['secret-key', 'secret-key=0', 'secret-key=5']) {
      try {
        of(v, 'other');
      } catch (e) {
        expect((e as Error).message).not.toContain('secret-key');
      }
    }
  });
});

describe('helpers', () => {
  it('endpointList trims and drops empty items', () => {
    expect(endpointList(' wss://a.example , ,ws://b.example:6006 ')).toEqual([
      'wss://a.example',
      'ws://b.example:6006',
    ]);
  });

  it('corsOriginOf is * or the exact origins', () => {
    expect(corsOriginOf({ corsOrigins: '*' })).toBe('*');
    expect(corsOriginOf({ corsOrigins: 'https://a.example, https://b.example' })).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(corsOriginOf({ corsOrigins: '' })).toEqual([]);
  });
});
