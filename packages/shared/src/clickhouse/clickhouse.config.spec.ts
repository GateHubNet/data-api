import { getNetworkProfile } from '../network';
import { clickHouseConfigFromEnv } from './clickhouse.config';

describe('clickHouseConfigFromEnv', () => {
  it('defaults the database to the network profile', () => {
    expect(clickHouseConfigFromEnv({}, getNetworkProfile('xrpl')).database).toBe('xrpl');
    expect(clickHouseConfigFromEnv({}, getNetworkProfile('xahau')).database).toBe('xahau');
  });

  it('derives the default profile from GH_NETWORK in the given env', () => {
    expect(clickHouseConfigFromEnv({ GH_NETWORK: 'xahau' }).database).toBe('xahau');
    expect(clickHouseConfigFromEnv({}).database).toBe(getNetworkProfile().defaultDatabase);
  });

  it('lets GH_CLICKHOUSE_DATABASE override the profile database', () => {
    const env = { GH_CLICKHOUSE_DATABASE: 'custom_db' };
    expect(clickHouseConfigFromEnv(env, getNetworkProfile('xahau')).database).toBe('custom_db');
  });

  it.each(['Bad-Name', '1abc', 'a b', 'a;DROP', 'UPPER', 'a`b', ''])('rejects the database name %j', (name) => {
    expect(() => clickHouseConfigFromEnv({ GH_CLICKHOUSE_DATABASE: name })).toThrow(/GH_CLICKHOUSE_DATABASE/);
  });

  it.each(['a', '_a', 'xrpl', 'xahau_2', 'default'])('accepts the database name %j', (name) => {
    expect(clickHouseConfigFromEnv({ GH_CLICKHOUSE_DATABASE: name }).database).toBe(name);
  });

  it('reads the connection settings and keeps their defaults', () => {
    expect(clickHouseConfigFromEnv({})).toEqual({
      url: 'http://localhost:8123',
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
