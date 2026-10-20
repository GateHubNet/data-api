import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';

/**
 * What the sets of the account and market aggregates (`native_rates_daily`, `pair_hourly`, `markets_live`, the account
 * rollups) have in common. A set is written whole, in one insert, under one version; a reader keeps the newest version of a
 * set and never uses FINAL (see `volume.job.ts`, whose own copies of these stay as they are).
 */

/** Thrown by a set whose `signal` was aborted: nothing was written after the abort. */
export class AggregateSetAborted extends Error {
  constructor() {
    super('The aggregate set was aborted before it wrote');
    this.name = 'AggregateSetAborted';
  }
}

export interface AggregateSetOptions {
  /**
   * Checked before the work and again just before the insert: an aborted set throws `AggregateSetAborted` and writes
   * nothing. The syncer aborts it when it shuts down, so that no row is written once the shutdown has begun.
   */
  signal?: AbortSignal;
}

export function throwIfSetAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AggregateSetAborted();
}

/**
 * The version of the next write of a set: the ClickHouse clock in milliseconds, but one past the newest version the set has
 * now, so that it only goes up. `where` selects the rows that tell the set's newest version (code, never input; every value
 * in it is bound through `params`); a set that does not exist has the clock.
 */
export async function nextSetVersion(
  ch: ClickHouseService,
  table: Table,
  where: string,
  params: Record<string, unknown>,
): Promise<number> {
  const [row] = await ch.query<{ newest: number | string; now_ms: number | string }>(
    `SELECT toUInt64(max(version)) AS newest, toUnixTimestamp64Milli(now64(3)) AS now_ms FROM ${table} WHERE ${where}`,
    params,
  );
  return Math.max(Number(row?.now_ms ?? Date.now()), Number(row?.newest ?? 0) + 1);
}

/** The close time of the newest ingested ledger (the highest index: a read of the end of the primary key), unix seconds. */
export async function newestLedgerClose(ch: ClickHouseService): Promise<number | undefined> {
  const row = await ch.queryOne<{ closed: number | string }>(
    `SELECT toUnixTimestamp(close_time) AS closed FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
  );
  return row === undefined ? undefined : Number(row.closed);
}
