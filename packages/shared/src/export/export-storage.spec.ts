import { Storage } from '@google-cloud/storage';
import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { EXPORT_URL_TTL_MS } from './export-jobs';
import { GcsExportStorage, MemoryExportStorage } from './export-storage';

describe('GcsExportStorage', () => {
  it('links a file with a V4 signed URL of the bucket, valid for the time asked (signed offline with a key)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const storage = new Storage({
      projectId: 'gatehub-test',
      credentials: { client_email: 'exporter@gatehub-test.iam.gserviceaccount.com', private_key: privateKey },
    });
    const gcs = new GcsExportStorage({ bucket: 'gh-exports', storage });

    const url = new URL(await gcs.signedUrl('xrpl/0123456789abcdef0123456789abcdef.csv', EXPORT_URL_TTL_MS));

    expect(`${url.origin}${url.pathname}`).toBe(
      'https://storage.googleapis.com/gh-exports/xrpl/0123456789abcdef0123456789abcdef.csv',
    );
    expect(url.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
    expect(url.searchParams.get('X-Goog-Expires')).toBe('900');
    expect(url.searchParams.get('X-Goog-Signature')).toMatch(/^[0-9a-f]+$/);
  });
});

describe('MemoryExportStorage', () => {
  it('downloads a file through its link until the link expires', async () => {
    let now = 1_000_000;
    const memory = new MemoryExportStorage(() => now);
    await memory.upload('xrpl/a.csv', Readable.from(['"a"\n', '"1"']), {
      contentType: 'text/csv',
      contentDisposition: 'attachment; filename="a.csv"',
    });
    const url = await memory.signedUrl('xrpl/a.csv', 1000);

    expect(memory.download(url)).toEqual({
      body: '"a"\n"1"',
      bytes: Buffer.from('"a"\n"1"'),
      contentType: 'text/csv',
      contentDisposition: 'attachment; filename="a.csv"',
    });
    now += 1000;
    expect(() => memory.download(url)).toThrow('The link has expired');
  });
});
