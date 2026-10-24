import type { Bucket, Storage } from '@google-cloud/storage';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** What a stored export file is served with. */
export interface ExportFileMeta {
  contentType: string;
  /** `attachment; filename=…`: the name the list's own download has. */
  contentDisposition?: string;
}

/**
 * Where export files go: Google Cloud Storage in production (`GcsExportStorage`), an in-memory store in tests
 * (`MemoryExportStorage`). The exporter uploads a file; the api makes a short-lived download link for it at each request.
 */
export interface ExportStorage {
  /** Stores `body` under `key` (`exportObjectKey`), replacing whatever was there. */
  upload(key: string, body: Readable, meta: ExportFileMeta): Promise<void>;
  /** A link that downloads the file at `key` for `ttlMs` milliseconds from now, and then no more. */
  signedUrl(key: string, ttlMs: number): Promise<string>;
}

export interface GcsExportStorageOptions {
  /** The bucket of every network's exports (`GH_EXPORT_BUCKET`); the keys carry the network's prefix. */
  bucket: string;
  /** The client. Default: one with the application default credentials (`GOOGLE_APPLICATION_CREDENTIALS`, ...). */
  storage?: Storage;
}

/**
 * The export files in a Google Cloud Storage bucket. Download links are V4 signed URLs, which the credentials sign:
 * a service account key, or a service account allowed to sign blobs (`iam.serviceAccounts.signBlob`) on its own.
 * Deleting the files after 7 days is the bucket's lifecycle rule, not this class.
 */
export class GcsExportStorage implements ExportStorage {
  private readonly bucket: Bucket;

  constructor(options: GcsExportStorageOptions) {
    // required here, not imported: only the apps that store exports load the client
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const storage =
      options.storage ?? new (require('@google-cloud/storage') as typeof import('@google-cloud/storage')).Storage();
    this.bucket = storage.bucket(options.bucket);
  }

  async upload(key: string, body: Readable, meta: ExportFileMeta): Promise<void> {
    const file = this.bucket.file(key);
    await pipeline(
      body,
      file.createWriteStream({
        contentType: meta.contentType,
        metadata: meta.contentDisposition === undefined ? {} : { contentDisposition: meta.contentDisposition },
      }),
    );
  }

  async signedUrl(key: string, ttlMs: number): Promise<string> {
    const [url] = await this.bucket
      .file(key)
      .getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + ttlMs });
    return url;
  }
}

/** A file of the in-memory store, as a download of a link gives it. */
export interface MemoryExportFile extends ExportFileMeta {
  body: string;
}

/**
 * The export files in memory, for tests: one instance shared by the api (links) and the exporter (uploads). A link is
 * `memory://exports/<key>?expires=<unix ms>`; `download` gives the file behind it while the link is valid.
 */
export class MemoryExportStorage implements ExportStorage {
  private readonly files = new Map<string, { body: Buffer; meta: ExportFileMeta }>();

  constructor(private readonly now: () => number = Date.now) {}

  async upload(key: string, body: Readable, meta: ExportFileMeta): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    this.files.set(key, { body: Buffer.concat(chunks), meta: { ...meta } });
  }

  async signedUrl(key: string, ttlMs: number): Promise<string> {
    return `memory://exports/${key}?expires=${this.now() + ttlMs}`;
  }

  /** The file a link of `signedUrl` downloads. Throws when the link has expired or names no file. */
  download(url: string): MemoryExportFile {
    const match = /^memory:\/\/exports\/(.+)\?expires=(\d+)$/.exec(url);
    if (!match) throw new Error(`Not a link of the in-memory store: ${url}`);
    if (this.now() >= Number(match[2])) throw new Error(`The link has expired: ${url}`);
    const file = this.files.get(match[1]);
    if (!file) throw new Error(`No file at ${match[1]}`);
    return { body: file.body.toString('utf8'), ...file.meta };
  }

  /** The keys of the stored files. */
  keys(): string[] {
    return [...this.files.keys()];
  }
}
