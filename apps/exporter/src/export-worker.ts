import {
  appendExportJob,
  ClickHouseService,
  exportJobsIn,
  ExportJobsRow,
  exportObjectKey,
  ExportStorage,
  nextExportState,
} from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CsvFile, UnreadableCsv } from './csv-file';

/** The largest page the lists serve (`limit`): the exporter asks for it, and a list with a smaller one serves that. */
export const EXPORT_PAGE_SIZE = 1000;
/** How often the exporter looks for a queued job while it has none. */
export const EXPORT_POLL_MS = 2000;
/** How long one page may take. */
export const EXPORT_REQUEST_TIMEOUT_MS = 60_000;
/** A list that has still a next page after this many is walked no further: the job fails. */
export const EXPORT_MAX_PAGES = 100_000;

export interface ExportWorkerOptions {
  /** The network's database, where the jobs are. */
  ch: ClickHouseService;
  /** Where the files go. */
  storage: ExportStorage;
  /** The network (`xrpl`, `xahau`): the prefix of its files in the storage. */
  network: string;
  /** The base URL of the network's api (`http://api-xrpl:3001`). */
  apiUrl: string;
  /** The exporter's own API key, sent as `X-API-Key`; `''` sends none (an api without keys). */
  apiKey: string;
  /** Default: `EXPORT_PAGE_SIZE`. */
  pageSize?: number;
  /** Default: `EXPORT_POLL_MS`. */
  pollMs?: number;
  /** Default: `EXPORT_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
  /** Default: a Nest `Logger` with the context `ExportWorker`. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** Told about every job that ends (the metrics). */
  onFinished?: (status: 'done' | 'failed', rows: number, seconds: number) => void;
}

/** A failure the client is told about, in these words: the message becomes the job's `error`. */
export class ExportFailure extends Error {}

/** The job was stopped by a shutdown: it goes back to the queue. */
class Stopped extends Error {}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The message of an error answer of the api: `{"result":"error","message":…}`, or the text as it is. */
function messageOf(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body?.message === 'string') return body.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}

/** The `marker` of the next page, from a `Link: <url>; rel="next"` header; `undefined` on the last page. */
function nextMarker(link: string | null): string | undefined {
  const next = link ? /<([^>]*)>\s*;\s*rel="next"/.exec(link)?.[1] : undefined;
  if (next === undefined) return undefined;
  try {
    return new URL(next).searchParams.get('marker') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The exporter of one network (spec #4, ticket #15): takes the queued export jobs of its database one at a time,
 * oldest first, and makes each file by walking the list's pages over HTTP through the network's api, with its own API
 * key. So an export is always the list it names, made by the list's one implementation.
 *
 * For a job it writes `running`, asks for `<path>&format=csv&limit=<pageSize>` and follows the `Link` of each page,
 * puts the pages together into one CSV (`CsvFile`), uploads it to `<network>/<id>.csv` with the name the list gives
 * its download, and writes `done` with the row count. A list that answers an error, an unreadable page or a failed
 * upload writes `failed` with why. It never stops on a failure: the next job is taken.
 *
 * It must be the only exporter of its database: two would take the same job. On start it fails the jobs a previous
 * exporter left `running` (it stopped without a shutdown); a shutdown stops the job in hand and queues it again.
 */
export class ExportWorker {
  private readonly pageSize: number;
  private readonly pollMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private readonly stopping = new AbortController();
  private loop?: Promise<void>;

  constructor(private readonly options: ExportWorkerOptions) {
    this.pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
    this.pollMs = options.pollMs ?? EXPORT_POLL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? EXPORT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? new Logger(ExportWorker.name);
  }

  /** Starts taking jobs. Not awaited: the loop runs until `stop()`. */
  start(): void {
    this.loop ??= this.run();
  }

  /** Stops the loop: the job in hand is stopped and queued again. Idempotent. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop;
  }

  /** Takes the oldest queued job and makes its file. `false` when there was none. */
  async runNext(): Promise<boolean> {
    const [queued] = await exportJobsIn(this.options.ch, 'queued', 1);
    if (!queued) return false;
    await this.make(queued);
    return true;
  }

  private async run(): Promise<void> {
    try {
      await this.failAbandoned();
    } catch (err) {
      this.logger.error(`Could not read the jobs left running: ${describe(err)}`);
    }
    while (!this.stopping.signal.aborted) {
      let worked = false;
      try {
        worked = await this.runNext();
      } catch (err) {
        this.logger.error(`Could not take an export job: ${describe(err)}`);
      }
      if (!worked) await this.pause();
    }
  }

  /** Waits `pollMs`, or less when the worker is stopped meanwhile. */
  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.stopping.signal;
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, this.pollMs);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done);
    });
  }

  /** The jobs a previous exporter left `running`: it stopped in the middle of them without a shutdown. */
  private async failAbandoned(): Promise<void> {
    for (const job of await exportJobsIn(this.options.ch, 'running')) {
      this.logger.warn(`Export ${job.id} was left running by a previous exporter: failed`);
      await appendExportJob(
        this.options.ch,
        nextExportState(job, {
          status: 'failed',
          error: 'the exporter stopped while it made this export: ask for it again',
        }),
      );
    }
  }

  private async make(queued: ExportJobsRow): Promise<void> {
    const { ch, storage, network } = this.options;
    const started = Date.now();
    const running = nextExportState(queued, { status: 'running' });
    await appendExportJob(ch, running);
    const dir = await mkdtemp(join(tmpdir(), 'export-'));
    try {
      const { file, disposition } = await this.walk(running, join(dir, 'rows'));
      const object = exportObjectKey(network, running.id, running.format);
      try {
        await storage.upload(object, file.stream(), {
          contentType: 'text/csv',
          ...(disposition !== null && { contentDisposition: disposition }),
        });
      } catch (err) {
        this.logger.error(`Export ${running.id}: the upload failed: ${describe(err)}`);
        throw new ExportFailure('the file could not be stored');
      }
      await appendExportJob(ch, nextExportState(running, { status: 'done', rows: file.rows, object }));
      this.logger.log(`Export ${running.id}: ${file.rows} rows in ${Date.now() - started} ms`);
      this.options.onFinished?.('done', file.rows, (Date.now() - started) / 1000);
    } catch (err) {
      if (err instanceof Stopped || this.stopping.signal.aborted) {
        this.logger.log(`Export ${running.id}: stopped by the shutdown, queued again`);
        await appendExportJob(ch, nextExportState(running, { status: 'queued' }));
        return;
      }
      const error =
        err instanceof ExportFailure || err instanceof UnreadableCsv ? err.message : 'the export failed unexpectedly';
      if (!(err instanceof ExportFailure)) this.logger.error(`Export ${running.id} failed: ${describe(err)}`);
      await appendExportJob(ch, nextExportState(running, { status: 'failed', error }));
      this.options.onFinished?.('failed', 0, (Date.now() - started) / 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Walks every page of the job's list into a `CsvFile` spooled at `spool`. */
  private async walk(job: ExportJobsRow, spool: string): Promise<{ file: CsvFile; disposition: string | null }> {
    const url = new URL(job.path, this.options.apiUrl);
    url.searchParams.set('format', job.format);
    url.searchParams.set('limit', String(this.pageSize));
    url.searchParams.delete('marker');
    const file = new CsvFile(spool);
    const seen = new Set<string>();
    let disposition: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= EXPORT_MAX_PAGES) throw new ExportFailure(`the list has more than ${EXPORT_MAX_PAGES} pages`);
      const res = await this.fetchPage(url);
      const text = await res.text();
      if (!res.ok) throw new ExportFailure(`the list answered ${res.status}: ${messageOf(text)}`);
      if (!(res.headers.get('content-type') ?? '').startsWith('text/csv')) {
        throw new ExportFailure('the list did not answer a CSV');
      }
      if (page === 0) disposition = res.headers.get('content-disposition');
      await file.add(text);
      const marker = nextMarker(res.headers.get('link'));
      if (marker === undefined) return { file, disposition };
      if (seen.has(marker)) throw new ExportFailure('the list gave the same page twice');
      seen.add(marker);
      url.searchParams.set('marker', marker);
    }
  }

  private async fetchPage(url: URL): Promise<Response> {
    if (this.stopping.signal.aborted) throw new Stopped();
    try {
      return await fetch(url, {
        headers: this.options.apiKey === '' ? {} : { 'X-API-Key': this.options.apiKey },
        signal: AbortSignal.any([this.stopping.signal, AbortSignal.timeout(this.requestTimeoutMs)]),
      });
    } catch (err) {
      if (this.stopping.signal.aborted) throw new Stopped();
      this.logger.error(`GET ${url.pathname} failed: ${describe(err)}`);
      throw new ExportFailure(
        (err as { name?: string })?.name === 'TimeoutError'
          ? `a page of the list took longer than ${this.requestTimeoutMs / 1000} s`
          : 'the list could not be read',
      );
    }
  }
}
