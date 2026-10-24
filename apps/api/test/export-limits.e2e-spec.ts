import { MemoryExportStorage } from '@gatehub/data-api-shared';
import { ExportWorker } from '../../exporter/src/export-worker';
import { Harness, NO_RATE_LIMIT, startHarness, TEST_API_KEY } from './harness';

/**
 * The limits of exports (spec #4, ticket #16): at most three queued or running exports per API key, and a row cap per
 * format. The caps are set small here (`GH_EXPORT_MAX_ROWS_*`) so that the mock ledgers exceed them. The exporter of the
 * network takes one job at a time when a test asks it to (`runNext`), so that a test knows which jobs are still queued.
 */

const BUSY = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q'; // 179 transactions in the mock ledgers
const OTHER_KEY = 'other-key';
const EXPORTER_KEY = 'exporter-key';
const transactions = (address: string, query: string) => `/v2/accounts/${address}/transactions?${query}`;
const WINDOW = 'start=2013-01-01&end=2016-01-01';

describe('export limits', () => {
  let h: Harness;
  let worker: ExportWorker;
  const storage = new MemoryExportStorage();

  beforeAll(async () => {
    h = await startHarness({
      seed: 'ripple-mock',
      exportStorage: storage,
      env: { ...NO_RATE_LIMIT, GH_API_KEYS: `${TEST_API_KEY},${OTHER_KEY},${EXPORTER_KEY}` },
    });
    worker = new ExportWorker({
      ch: h.ch,
      storage,
      network: 'xrpl',
      apiUrl: await h.app.getUrl(),
      apiKey: EXPORTER_KEY,
      logger: { log: () => undefined, warn: () => undefined, error: (message: string) => console.error(message) },
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  const post = (body: object, key = TEST_API_KEY) => h.http().post('/v2/exports').set('X-API-Key', key).send(body);
  const status = (id: string, key = TEST_API_KEY) => h.http().get(`/v2/exports/${id}`).set('X-API-Key', key);
  /** Makes every queued export, oldest first. */
  const drain = async () => {
    while (await worker.runNext());
  };

  describe('at most three exports per API key', () => {
    afterEach(drain);

    it('answers 429 to a fourth while three of the key are queued, and another key may still ask', async () => {
      const path = transactions(BUSY, 'start=2015-01-14&end=2015-01-15');
      for (let i = 0; i < 3; i++) expect((await post({ path, format: 'csv' })).status).toBe(202);

      const fourth = await post({ path, format: 'csv' });
      expect([fourth.status, fourth.body]).toEqual([
        429,
        { result: 'error', message: 'too many exports in progress: at most 3 per API key' },
      ]);
      expect((await post({ path, format: 'csv' }, OTHER_KEY)).status).toBe(202);
    });

    it('takes a new one once an export of the key is done', async () => {
      const path = transactions(BUSY, 'start=2015-01-14&end=2015-01-15');
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await post({ path, format: 'csv' })).body.id);
      expect((await post({ path, format: 'csv' })).status).toBe(429);

      expect(await worker.runNext()).toBe(true);
      expect((await status(ids[0])).body.status).toBe('done');
      expect((await post({ path, format: 'csv' })).status).toBe(202);
    });

    it('takes a new one once an export of the key has failed', async () => {
      const failing = transactions(BUSY, `${WINDOW}&type=payment`); // the list answers 400 to this type
      const path = transactions(BUSY, 'start=2015-01-14&end=2015-01-15');
      const id = (await post({ path: failing, format: 'csv' })).body.id;
      for (let i = 0; i < 2; i++) expect((await post({ path, format: 'csv' })).status).toBe(202);
      expect((await post({ path, format: 'csv' })).status).toBe(429);

      expect(await worker.runNext()).toBe(true);
      expect((await status(id)).body.status).toBe('failed');
      expect((await post({ path, format: 'csv' })).status).toBe(202);
    });
  });
});
