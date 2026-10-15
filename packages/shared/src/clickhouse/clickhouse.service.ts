import { ClickHouseClient, ClickHouseSettings, createClient } from '@clickhouse/client';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CLICKHOUSE_CONFIG, ClickHouseConfig } from './clickhouse.config';
import { Table } from './tables';

export interface InsertOptions {
  /**
   * Sent as `insert_deduplication_token`: a replay of the same token is dropped by the server instead of being
   * hashed by content. Only effective on a table with `non_replicated_deduplication_window` > 0.
   */
  dedupToken?: string;
  /**
   * Sent as the request's `query_id`, so the insert can be found in `system.processes` while it runs and in
   * `system.query_log` afterwards, and killed by id. ClickHouse rejects a second query with the id of a running one.
   */
  queryId?: string;
}

export interface CommandOptions {
  /** Sent as the request's `query_id` (see `InsertOptions.queryId`). */
  queryId?: string;
  /** Merged over the defaults of `command` (`wait_end_of_query: 1`). */
  settings?: ClickHouseSettings;
}

/**
 * Thin, typed wrapper around the official ClickHouse client.
 *
 * - `query<T>()` runs a parameterised SELECT and returns typed rows. Always use
 *   `query_params` (never string interpolation) so user input cannot be injected.
 * - `insert()` bulk-inserts rows for the syncer. Deduplication is opted into per insert (`dedupToken`), never globally.
 * - `command()` runs DDL / DML (used by the migration runner and the ingest bookkeeping).
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

  /**
   * Parameterised SELECT. Pass values via `params` — they are bound, never interpolated. `settings` are merged over
   * the safety guards, so a caller can raise a limit for one known-heavy query.
   */
  async query<T = Record<string, unknown>>(
    query: string,
    params: Record<string, unknown> = {},
    settings: ClickHouseSettings = {},
  ): Promise<T[]> {
    const resultSet = await this.client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: { ...this.queryGuards, ...settings },
    });
    return resultSet.json<T>();
  }

  /** SELECT returning a single row (or undefined). */
  async queryOne<T = Record<string, unknown>>(
    query: string,
    params: Record<string, unknown> = {},
    settings: ClickHouseSettings = {},
  ): Promise<T | undefined> {
    const rows = await this.query<T>(query, params, settings);
    return rows[0];
  }

  /**
   * Bulk insert. `table` is a trusted `Table` enum value (never user input); `rows` are JSON objects.
   *
   * Every insert is synchronous (`async_insert: 0`): ClickHouse 26.8 defaults to async inserts, whose deduplication is
   * off unless asked for and which acknowledge a row before it is a part. The ledger writer's exactly-once ordering
   * (child rows, then the commit marker) needs the rows to be on disk, in order, when the call returns.
   */
  async insert<T>(table: Table | string, rows: T[], opts: InsertOptions = {}): Promise<void> {
    if (rows.length === 0) return;
    await this.client.insert({
      table,
      values: rows,
      format: 'JSONEachRow',
      ...(opts.queryId !== undefined && { query_id: opts.queryId }),
      clickhouse_settings: {
        async_insert: 0,
        ...(opts.dedupToken !== undefined && { insert_deduplication_token: opts.dedupToken }),
      },
    });
  }

  /** Run a DDL / DML command (CREATE TABLE, ALTER, lightweight DELETE …). Values go through `params`. */
  async command(query: string, params: Record<string, unknown> = {}, opts: CommandOptions = {}): Promise<void> {
    await this.client.command({
      query,
      query_params: params,
      ...(opts.queryId !== undefined && { query_id: opts.queryId }),
      clickhouse_settings: { wait_end_of_query: 1, ...opts.settings },
    });
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
