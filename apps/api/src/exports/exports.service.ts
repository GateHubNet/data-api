import {
  activeExportJobs,
  appendExportJob,
  ClickHouseService,
  EXPORT_FORMATS,
  EXPORT_URL_TTL_MS,
  ExportFormat,
  ExportJobsRow,
  exportNow,
  ExportStorage,
  isExportId,
  newExportId,
  readExportJob,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { badRequest, notFound, RippleHttpError } from '../common/errors';
import { fmtTime } from '../common/format';
import { ApiConfig } from '../config/api.config';
import { ExportableRoutes } from './exportable-routes';

/** The token of the `ExportStorage` of the api: `null` when exports are off (`GH_EXPORT_BUCKET` empty). */
export const EXPORT_STORAGE = Symbol('EXPORT_STORAGE');

/** The answer of `GET /v2/exports/{id}`, in this key order. */
export interface ExportBody {
  result: 'success';
  id: string;
  status: ExportJobsRow['status'];
  format: string;
  path: string;
  created: string;
  finished?: string;
  rows?: number;
  error?: string;
  url?: string;
}

/** The base that a path is resolved against: only its path and query are kept. */
const BASE = 'http://export.invalid';

/**
 * Export jobs on the api's side (ticket #15): checks and queues a request (`POST /v2/exports`) and reports a job to the
 * key that asked for it (`GET /v2/exports/{id}`), with a new download link at each request once it is done. The
 * exporter of the network does the rest.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly routes: ExportableRoutes,
    private readonly config: ApiConfig,
    @Optional() @Inject(EXPORT_STORAGE) private readonly storage: ExportStorage | null = null,
  ) {}

  /**
   * Queues an export of `body.path` in `body.format` for the key whose hash is `keyHash`. The checks, in order: the path
   * (a `/v2/` path of a list with a CSV form), its window (a list over time names `start` and `end`), the format, then
   * the exports the key already has queued or running (ticket #16: at most `GH_EXPORT_MAX_JOBS_PER_KEY`, 429 beyond).
   */
  async create(body: unknown, keyHash: string): Promise<Pick<ExportBody, 'result' | 'id' | 'status'>> {
    this.available();
    const { path, format } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof path !== 'string' || !path.startsWith('/v2/')) throw badRequest('invalid path');
    const url = new URL(path, BASE);
    const route = this.routes.match(url.pathname);
    if (!route) throw badRequest('path is not exportable');
    if (route.overTime && (!url.searchParams.get('start') || !url.searchParams.get('end'))) {
      throw badRequest('start and end are required');
    }
    if (typeof format !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
      throw badRequest('invalid format');
    }
    const most = this.config.exportMaxJobsPerKey;
    if ((await activeExportJobs(this.ch, keyHash)) >= most) {
      throw new RippleHttpError(429, `too many exports in progress: at most ${most} per API key`);
    }

    const now = exportNow();
    const job: ExportJobsRow = {
      id: newExportId(),
      seq: 0,
      key_hash: keyHash,
      path,
      format: format as ExportFormat,
      status: 'queued',
      created: now,
      at: now,
      rows: 0,
      object: '',
      error: '',
    };
    await appendExportJob(this.ch, job);
    return { result: 'success', id: job.id, status: job.status };
  }

  /** The job `id` for the key whose hash is `keyHash`: 404 for an unknown job and for a job of another key. */
  async find(id: string, keyHash: string): Promise<ExportBody> {
    this.available();
    const job = isExportId(id) ? await readExportJob(this.ch, id) : undefined;
    if (!job || job.key_hash !== keyHash) throw notFound('export not found');
    const finished = job.status === 'done' || job.status === 'failed';
    return {
      result: 'success',
      id: job.id,
      status: job.status,
      format: job.format,
      path: job.path,
      created: fmtTime(Number(job.created)),
      ...(finished && { finished: fmtTime(Number(job.at)) }),
      ...(job.status === 'done' && { rows: Number(job.rows) }),
      ...(job.status === 'failed' && { error: job.error }),
      ...(job.status === 'done' && { url: await this.storage!.signedUrl(job.object, EXPORT_URL_TTL_MS) }),
    };
  }

  /** 503 when exports are off: there is nowhere to keep the files. */
  private available(): void {
    if (!this.storage) throw new RippleHttpError(503, 'exports are not available');
  }
}
