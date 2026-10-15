import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { ClickHouseConfig, clickHouseConfigFromEnv } from '../src/clickhouse/clickhouse.config';

/**
 * Pinned ClickHouse LTS used by every integration test (and by the compose files). LTS releases are the `.3` and `.8`
 * minors. Override with `CLICKHOUSE_IMAGE` to try another tag.
 */
export const DEFAULT_CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:26.8.14.3';

export interface StartedClickHouse {
  container: StartedTestContainer;
  url: string;
  database: string;
  /** Connection config for the started server, bound to `database`. */
  config: ClickHouseConfig;
}

/**
 * Boots a throwaway ClickHouse in Docker for integration tests and exports the connection into the environment (read by
 * the shared config). The caller then runs `runMigrations()` to apply the real schema.
 *
 * With a `database` the image creates it on startup (`CLICKHOUSE_DB`). Without one no extra database exists and
 * `database` is `default`; the migration runner creates its own database.
 */
export async function startClickHouse(database?: string): Promise<StartedClickHouse> {
  const image = process.env.CLICKHOUSE_IMAGE || DEFAULT_CLICKHOUSE_IMAGE;
  const container = await new GenericContainer(image)
    .withExposedPorts(8123)
    .withEnvironment({
      ...(database ? { CLICKHOUSE_DB: database } : {}),
      CLICKHOUSE_USER: 'default',
      CLICKHOUSE_PASSWORD: '',
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
    })
    .withWaitStrategy(Wait.forHttp('/ping', 8123).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();

  const url = `http://${container.getHost()}:${container.getMappedPort(8123)}`;
  const resolvedDatabase = database ?? 'default';
  process.env.GH_CLICKHOUSE_URL = url;
  process.env.GH_CLICKHOUSE_DATABASE = resolvedDatabase;
  process.env.GH_CLICKHOUSE_USER = 'default';
  process.env.GH_CLICKHOUSE_PASSWORD = '';

  const config = clickHouseConfigFromEnv(process.env);
  return { container, url, database: resolvedDatabase, config };
}
