import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

export interface StartedClickHouse {
  container: StartedTestContainer;
  url: string;
  database: string;
}

/**
 * Boots a throwaway ClickHouse in Docker for integration tests and exports the
 * connection into the environment (read by the shared config). The caller then runs
 * `runMigrations()` to apply the real schema.
 */
export async function startClickHouse(database = 'xrpl'): Promise<StartedClickHouse> {
  const container = await new GenericContainer('clickhouse/clickhouse-server:24.8')
    .withExposedPorts(8123)
    .withEnvironment({
      CLICKHOUSE_DB: database,
      CLICKHOUSE_USER: 'default',
      CLICKHOUSE_PASSWORD: '',
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
    })
    .withWaitStrategy(Wait.forHttp('/ping', 8123).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();

  const url = `http://${container.getHost()}:${container.getMappedPort(8123)}`;
  process.env.GH_CLICKHOUSE_URL = url;
  process.env.GH_CLICKHOUSE_DATABASE = database;
  process.env.GH_CLICKHOUSE_USER = 'default';
  process.env.GH_CLICKHOUSE_PASSWORD = '';

  return { container, url, database };
}
