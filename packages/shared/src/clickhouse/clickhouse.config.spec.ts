import { getNetworkProfile } from '../network';
import { clickHouseConfigFromEnv, sharedDatabaseFromEnv } from './clickhouse.config';
import { ClickHouseModule } from './clickhouse.module';

const URL = { GH_CLICKHOUSE_URL: 'http://ch:8123' };

describe('clickHouseConfigFromEnv', () => {
  it.each([[{}], [{ GH_CLICKHOUSE_URL: '' }], [{ GH_CLICKHOUSE_URL: '  ' }]])(
    'has no default server: refuses %j, naming the variable',
    (env) => {
      expect(() => clickHouseConfigFromEnv(env)).toThrow(/GH_CLICKHOUSE_URL/);
    },
  );

  it('defaults the database to the network profile', () => {
    expect(clickHouseConfigFromEnv(URL, getNetworkProfile('xrpl')).database).toBe('xrpl');
    expect(clickHouseConfigFromEnv(URL, getNetworkProfile('xahau')).database).toBe('xahau');
  });

  it('derives the default profile from GH_NETWORK in the given env', () => {
    expect(clickHouseConfigFromEnv({ ...URL, GH_NETWORK: 'xahau' }).database).toBe('xahau');
    expect(clickHouseConfigFromEnv(URL).database).toBe(getNetworkProfile().defaultDatabase);
  });

  it('lets GH_CLICKHOUSE_DATABASE override the profile database', () => {
    const env = { ...URL, GH_CLICKHOUSE_DATABASE: 'custom_db' };
    expect(clickHouseConfigFromEnv(env, getNetworkProfile('xahau')).database).toBe('custom_db');
  });

  it.each(['Bad-Name', '1abc', 'a b', 'a;DROP', 'UPPER', 'a`b', ''])('rejects the database name %j', (name) => {
    expect(() => clickHouseConfigFromEnv({ ...URL, GH_CLICKHOUSE_DATABASE: name })).toThrow(/GH_CLICKHOUSE_DATABASE/);
  });

  it.each(['a', '_a', 'xrpl', 'xahau_2', 'default'])('accepts the database name %j', (name) => {
    expect(clickHouseConfigFromEnv({ ...URL, GH_CLICKHOUSE_DATABASE: name }).database).toBe(name);
  });

  it.each([[{}], [{ GH_CLICKHOUSE_CLUSTER: '' }], [{ GH_CLICKHOUSE_CLUSTER: '  ' }]])('has no cluster for %j', (env) => {
    expect(clickHouseConfigFromEnv({ ...URL, ...env }).cluster).toBeUndefined();
  });

  it.each(['default', 'clickhouse', 'xrpl_cluster', 'prod-1.eu'])('accepts the cluster name %j', (name) => {
    expect(clickHouseConfigFromEnv({ ...URL, GH_CLICKHOUSE_CLUSTER: name }).cluster).toBe(name);
  });

  it.each(["a'b", 'a b', 'a;DROP', '{cluster}'])('rejects the cluster name %j', (name) => {
    expect(() => clickHouseConfigFromEnv({ ...URL, GH_CLICKHOUSE_CLUSTER: name })).toThrow(/GH_CLICKHOUSE_CLUSTER/);
  });

  it('reads the connection settings and keeps their defaults', () => {
    expect(clickHouseConfigFromEnv(URL)).toEqual({
      url: 'http://ch:8123',
      username: 'default',
      password: '',
      database: getNetworkProfile().defaultDatabase,
      requestTimeout: 30_000,
      maxOpenConnections: 10,
      maxExecutionTime: 30,
      maxQueryMemoryBytes: 0,
    });
    expect(
      clickHouseConfigFromEnv({
        GH_CLICKHOUSE_URL: 'http://ch:8123',
        GH_CLICKHOUSE_USER: 'u',
        GH_CLICKHOUSE_PASSWORD: 'p',
        GH_CLICKHOUSE_REQUEST_TIMEOUT: '5000',
        GH_CLICKHOUSE_MAX_CONNECTIONS: '3',
        GH_CLICKHOUSE_MAX_EXECUTION_TIME: '7',
        GH_CLICKHOUSE_MAX_QUERY_MEMORY: '1024',
      }),
    ).toMatchObject({
      url: 'http://ch:8123',
      username: 'u',
      password: 'p',
      requestTimeout: 5000,
      maxOpenConnections: 3,
      maxExecutionTime: 7,
      maxQueryMemoryBytes: 1024,
    });
  });
});

describe('ClickHouseModule.forRoot', () => {
  const saved = process.env.GH_CLICKHOUSE_URL;
  beforeEach(() => delete process.env.GH_CLICKHOUSE_URL);
  afterAll(() => {
    if (saved !== undefined) process.env.GH_CLICKHOUSE_URL = saved;
  });

  const configOf = (config?: Parameters<typeof ClickHouseModule.forRoot>[0]): unknown =>
    (ClickHouseModule.forRoot(config).providers?.[0] as { useValue: unknown }).useValue;

  it('refuses without a server named anywhere', () => {
    expect(() => ClickHouseModule.forRoot()).toThrow(/GH_CLICKHOUSE_URL/);
    expect(() => ClickHouseModule.forRoot({ database: 'x' })).toThrow(/GH_CLICKHOUSE_URL/);
  });

  it('takes the server from the caller, or else from the environment', () => {
    expect(configOf({ url: 'http://caller:8123' })).toMatchObject({ url: 'http://caller:8123' });
    process.env.GH_CLICKHOUSE_URL = 'http://env:8123';
    expect(configOf()).toMatchObject({ url: 'http://env:8123' });
    expect(configOf({ url: 'http://caller:8123' })).toMatchObject({ url: 'http://caller:8123' });
  });
});

describe('sharedDatabaseFromEnv', () => {
  it('is `shared` when GH_CLICKHOUSE_SHARED_DATABASE is unset or empty, on every network', () => {
    expect(sharedDatabaseFromEnv({})).toBe('shared');
    expect(sharedDatabaseFromEnv({ GH_CLICKHOUSE_SHARED_DATABASE: '', GH_NETWORK: 'xahau' })).toBe('shared');
  });

  it('is GH_CLICKHOUSE_SHARED_DATABASE when set', () => {
    expect(sharedDatabaseFromEnv({ GH_CLICKHOUSE_SHARED_DATABASE: 'shared_test' })).toBe('shared_test');
  });

  it.each(['Bad-Name', '1abc', 'a;DROP'])('rejects the database name %j, naming the variable', (name) => {
    expect(() => sharedDatabaseFromEnv({ GH_CLICKHOUSE_SHARED_DATABASE: name })).toThrow(
      /GH_CLICKHOUSE_SHARED_DATABASE/,
    );
  });
});
