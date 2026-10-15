/**
 * ClickHouse connection settings, read from the environment.
 *
 * Env vars (prefixed GH_CLICKHOUSE_*) keep parity with the GateHub config convention.
 * Both services (api, syncer) share the same connection config shape.
 */
export interface ClickHouseConfig {
  url: string;
  username: string;
  password: string;
  database: string;
  /** Request timeout in ms. */
  requestTimeout: number;
  /** Max concurrent HTTP connections in the client pool. */
  maxOpenConnections: number;
  /** Per-query wall-clock cap in seconds (0 = unlimited). Kills runaway queries. */
  maxExecutionTime: number;
  /** Per-query memory cap in bytes (0 = use server default). Defends against OOM. */
  maxQueryMemoryBytes: number;
}

export function clickHouseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ClickHouseConfig {
  return {
    url: env.GH_CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: env.GH_CLICKHOUSE_USER ?? 'default',
    password: env.GH_CLICKHOUSE_PASSWORD ?? '',
    database: env.GH_CLICKHOUSE_DATABASE ?? 'xrpl',
    requestTimeout: Number(env.GH_CLICKHOUSE_REQUEST_TIMEOUT ?? 30_000),
    maxOpenConnections: Number(env.GH_CLICKHOUSE_MAX_CONNECTIONS ?? 10),
    maxExecutionTime: Number(env.GH_CLICKHOUSE_MAX_EXECUTION_TIME ?? 30),
    maxQueryMemoryBytes: Number(env.GH_CLICKHOUSE_MAX_QUERY_MEMORY ?? 0),
  };
}

export const CLICKHOUSE_CONFIG = Symbol('CLICKHOUSE_CONFIG');
