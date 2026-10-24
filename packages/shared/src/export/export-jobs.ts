import { createHash, randomBytes } from 'node:crypto';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { ExportJobsRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';

/**
 * Export jobs (spec #4, ticket #15): the state the api and the exporter of a network share, in `export_jobs`.
 *
 * The table is append-only. The api writes the `queued` row (seq 0); the exporter writes `running` when it takes the
 * job, then `done` or `failed`, each with the next seq. Every row repeats the job, so the row with the highest seq of an
 * id is the job, and nothing is ever updated in place.
 */

/** The formats an export can be made in. PDF (ticket #17) joins this list. */
export const EXPORT_FORMATS = ['csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ExportStatus = ExportJobsRow['status'];

/** How long a download link of a done export is valid: 15 minutes, a new link at each request. */
export const EXPORT_URL_TTL_MS = 15 * 60 * 1000;

/** How long an export is kept: 7 days (the TTL of `export_jobs`, and the lifecycle rule of the bucket). */
export const EXPORT_RETENTION_DAYS = 7;

/** An unguessable job id: 128 random bits as 32 hex digits. */
export function newExportId(): string {
  return randomBytes(16).toString('hex');
}

/** Whether `id` has the shape of a job id, so that anything else is not found without asking ClickHouse. */
export function isExportId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

/** What a job records of the API key that asked for it: the hex SHA-256 of the key, `''` without one. Never the key. */
export function exportKeyHash(key: string | undefined): string {
  return key === undefined || key === '' ? '' : createHash('sha256').update(key).digest('hex');
}

/** Where the file of a job is stored: under the network's prefix, `<network>/<id>.<format>`. */
export function exportObjectKey(network: string, id: string, format: string): string {
  return `${network}/${id}.${format}`;
}

/** The current time as a `DateTime64(3)` value: unix seconds with the milliseconds as the fraction. */
export function exportNow(now: number = Date.now()): number {
  return now / 1000;
}

// The columns read back, with the times as unix seconds (with milliseconds) and the row count exact.
const COLUMNS = `id, seq, key_hash, path, format, status, toUnixTimestamp64Milli(created) / 1000 AS created,
  toUnixTimestamp64Milli(at) / 1000 AS at, toString(rows) AS rows, object, error`;

/** The newest row of every job: the jobs as they are now. */
const CURRENT = `SELECT ${COLUMNS} FROM ${Table.ExportJobs} ORDER BY id, seq DESC LIMIT 1 BY id`;

/** The job `id` as it is now, or `undefined` when there is none (or it is older than 7 days). */
export async function readExportJob(ch: ClickHouseService, id: string): Promise<ExportJobsRow | undefined> {
  return ch.queryOne<ExportJobsRow>(
    `SELECT ${COLUMNS} FROM ${Table.ExportJobs} WHERE id = {id:String} ORDER BY seq DESC LIMIT 1`,
    { id },
  );
}

/** The jobs whose current state is `status`, the oldest first. */
export async function exportJobsIn(
  ch: ClickHouseService,
  status: ExportStatus,
  limit?: number,
): Promise<ExportJobsRow[]> {
  return ch.query<ExportJobsRow>(
    `SELECT * FROM (${CURRENT}) WHERE status = {status:String} ORDER BY created, id` +
      (limit === undefined ? '' : ' LIMIT {limit:UInt32}'),
    { status, ...(limit !== undefined && { limit }) },
  );
}

/** Appends a state of a job. */
export async function appendExportJob(ch: ClickHouseService, row: ExportJobsRow): Promise<void> {
  await ch.insert(Table.ExportJobs, [row]);
}

/** The next state of `job`: the same job, one seq further, entered now. */
export function nextExportState(
  job: ExportJobsRow,
  change: Pick<ExportJobsRow, 'status'> & Partial<Pick<ExportJobsRow, 'rows' | 'object' | 'error'>>,
  now: number = Date.now(),
): ExportJobsRow {
  return {
    ...job,
    seq: Number(job.seq) + 1,
    at: exportNow(now),
    rows: 0,
    object: '',
    error: '',
    ...change,
  };
}
