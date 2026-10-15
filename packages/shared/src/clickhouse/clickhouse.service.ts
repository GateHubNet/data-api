import { ClickHouseClient, ClickHouseSettings, createClient } from '@clickhouse/client';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CLICKHOUSE_CONFIG, ClickHouseConfig } from './clickhouse.config';

/**
 * Thin, typed wrapper around the official ClickHouse client.
 *
 * - `query<T>()` runs a parameterised SELECT and returns typed rows. Always use
 *   `query_params` (never string interpolation) so user input cannot be injected.
 * - `insert()` bulk-inserts rows for the syncer.
 * - `command()` runs DDL (used by the migration runner).
 */
@Injectable()
export class ClickHouseService implements OnModuleDestroy {
  private readonly logger = new Logger(ClickHouseService.name);
  private readonly client: ClickHouseClient;

  constructor(@Inject(CLICKHOUSE_CONFIG) private readonly config: ClickHouseConfig) {
    this.client = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
      request_timeout: config.requestTimeout,
      max_open_connections: config.maxOpenConnections,
      clickhouse_settings: {
        // Idempotent inserts: identical blocks (same ledger replayed) are de-duplicated server-side.
        insert_deduplicate: 1,
        async_insert: 0,
      },
      application: 'gatehub-data-api',
    });
  }

  /** Per-query safety guards (wall-clock + memory cap) applied to every SELECT. */
  private get queryGuards(): ClickHouseSettings {
    const guards: ClickHouseSettings = {};
    if (this.config.maxExecutionTime > 0) guards.max_execution_time = this.config.maxExecutionTime;
    if (this.config.maxQueryMemoryBytes > 0) guards.max_memory_usage = String(this.config.maxQueryMemoryBytes);
    return guards;
  }

  /** Parameterised SELECT. Pass values via `params` — they are bound, never interpolated. */
  async query<T = Record<string, unknown>>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const resultSet = await this.client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: this.queryGuards,
    });
    return resultSet.json<T>();
  }

  /** SELECT returning a single row (or undefined). */
  async queryOne<T = Record<string, unknown>>(query: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
    const rows = await this.query<T>(query, params);
    return rows[0];
  }

  /** Bulk insert. `table` is a trusted enum value; `rows` are JSON objects. */
  async insert<T extends Record<string, unknown>>(table: string, rows: T[]): Promise<void> {
    if (rows.length === 0) return;
    await this.client.insert({
      table,
      values: rows,
      format: 'JSONEachRow',
    });
  }

  /** Run a DDL / DML command (CREATE TABLE, ALTER, OPTIMIZE …). */
  async command(query: string): Promise<void> {
    await this.client.command({ query, clickhouse_settings: { wait_end_of_query: 1 } });
  }

  /** Liveness probe used by the health module. */
  async ping(): Promise<boolean> {
    const result = await this.client.ping();
    if (!result.success) {
      this.logger.warn(`ClickHouse ping failed: ${String(result.error)}`);
    }
    return result.success;
  }

  get raw(): ClickHouseClient {
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}
