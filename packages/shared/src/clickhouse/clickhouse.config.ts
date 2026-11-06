import { getNetworkProfile, NetworkProfile } from '../network';

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
  /**
   * `GH_CLICKHOUSE_CLUSTER`: the server's cluster (`remote_servers`) when it runs as several replicas. Set, the migration
   * creates the database `ON CLUSTER` with the Replicated engine, so the schema and the data reach every replica.
   */
  cluster?: string;
}

/** Database names are interpolated into DDL, so only plain lowercase identifiers are accepted. */
const DATABASE_NAME = /^[a-z_][a-z0-9_]*$/;

export function assertValidDatabaseName(database: string, variable = 'GH_CLICKHOUSE_DATABASE'): string {
  if (!DATABASE_NAME.test(database)) {
    throw new Error(`Invalid ClickHouse database name "${database}" (${variable} must match ${DATABASE_NAME})`);
  }
  return database;
}

/** Cluster names are written into DDL as a quoted literal: letters, digits, `_`, `-` and `.` only. */
const CLUSTER_NAME = /^[A-Za-z0-9_.-]+$/;

function clusterFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const cluster = env.GH_CLICKHOUSE_CLUSTER?.trim();
  if (!cluster) return undefined;
  if (!CLUSTER_NAME.test(cluster)) {
    throw new Error(`Invalid ClickHouse cluster name "${cluster}" (GH_CLICKHOUSE_CLUSTER must match ${CLUSTER_NAME})`);
  }
  return cluster;
}

/** The name of the shared database when `GH_CLICKHOUSE_SHARED_DATABASE` is not set. */
export const DEFAULT_SHARED_DATABASE = 'shared';

/**
 * The shared database (ADR-0014): the one database on the server that the apis of every network read, which holds what
 * belongs to an address on every network (account names, labels). `GH_CLICKHOUSE_SHARED_DATABASE`, or `shared`.
 */
export function sharedDatabaseFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return assertValidDatabaseName(
    env.GH_CLICKHOUSE_SHARED_DATABASE || DEFAULT_SHARED_DATABASE,
    'GH_CLICKHOUSE_SHARED_DATABASE',
  );
}

/**
 * The server's address, which has no default: a tool started without it stops here, instead of reaching whatever listens on this
 * machine's port 8123.
 */
function clickHouseUrlFromEnv(env: NodeJS.ProcessEnv): string {
  const url = env.GH_CLICKHOUSE_URL?.trim();
  if (!url)
    throw new Error('GH_CLICKHOUSE_URL is not set: name the ClickHouse server, for example http://localhost:8123');
  return url;
}

/**
 * Build the connection config from `env`. The server is `GH_CLICKHOUSE_URL`, which is required. The database is `GH_CLICKHOUSE_DATABASE` when set, otherwise the network
 * profile's default (`xrpl`, `xahau`, `xrpl_testnet` or `xahau_testnet`); the profile defaults to the one selected by
 * `GH_NETWORK` in `env`.
 */
export function clickHouseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  profile: NetworkProfile = getNetworkProfile(env.GH_NETWORK || undefined),
): ClickHouseConfig {
  return {
    url: clickHouseUrlFromEnv(env),
    username: env.GH_CLICKHOUSE_USER ?? 'default',
    password: env.GH_CLICKHOUSE_PASSWORD ?? '',
    database: assertValidDatabaseName(env.GH_CLICKHOUSE_DATABASE ?? profile.defaultDatabase),
    requestTimeout: Number(env.GH_CLICKHOUSE_REQUEST_TIMEOUT ?? 30_000),
    maxOpenConnections: Number(env.GH_CLICKHOUSE_MAX_CONNECTIONS ?? 10),
    maxExecutionTime: Number(env.GH_CLICKHOUSE_MAX_EXECUTION_TIME ?? 30),
    maxQueryMemoryBytes: Number(env.GH_CLICKHOUSE_MAX_QUERY_MEMORY ?? 0),
    cluster: clusterFromEnv(env),
  };
}

export const CLICKHOUSE_CONFIG = Symbol('CLICKHOUSE_CONFIG');
