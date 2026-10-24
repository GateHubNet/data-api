import { MemoryExportStorage } from '@gatehub/data-api-shared';
import { ExportWorker } from '../../exporter/src/export-worker';
import { Harness, NO_RATE_LIMIT, startHarness, TEST_API_KEY } from './harness';

/**
 * `POST /v2/exports` and `GET /v2/exports/{id}` (spec #4, ticket #15): an investigator asks for an export of a list and
 * fetches the file once it is done. The exporter of the network runs here against the same ClickHouse and this harness's
 * api, walking the list's pages over HTTP with its own key, and keeps the files in an in-memory store instead of Google
 * Cloud Storage.
 */

const BUSY = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q'; // 179 transactions in the mock ledgers
const OTHER_KEY = 'other-key';
const EXPORTER_KEY = 'exporter-key';
const transactions = (address: string, query: string) => `/v2/accounts/${address}/transactions?${query}`;

describe('exports', () => {
  let h: Harness;
  const storage = new MemoryExportStorage();

  beforeAll(async () => {
    h = await startHarness({
      seed: 'ripple-mock',
      exportStorage: storage,
      env: { ...NO_RATE_LIMIT, GH_API_KEYS: `${TEST_API_KEY},${OTHER_KEY},${EXPORTER_KEY}` },
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  const post = (body: object, key = TEST_API_KEY) => h.http().post('/v2/exports').set('X-API-Key', key).send(body);
  const status = (id: string, key = TEST_API_KEY) => h.http().get(`/v2/exports/${id}`).set('X-API-Key', key);

  describe('asking for an export', () => {
    it('answers 202 with an unguessable id and queued, and the job says so', async () => {
      const path = transactions(BUSY, 'start=2013-01-01&end=2016-01-01');
      const res = await post({ path, format: 'csv' });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ result: 'success', id: expect.stringMatching(/^[0-9a-f]{32}$/), status: 'queued' });

      const job = await status(res.body.id);
      expect(job.status).toBe(200);
      expect(job.body).toEqual({
        result: 'success',
        id: res.body.id,
        status: 'queued',
        format: 'csv',
        path,
        created: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      });
    });

    it('takes any list with a CSV form: a point-in-time list needs no window and may name a ledger', async () => {
      for (const path of [
        `/v2/accounts/${BUSY}/balances?ledger_index=11119600`,
        `/v2/accounts/${BUSY}/balances`,
        '/v2/network/validators',
        `/v2/accounts/${BUSY}/payments?start=2013-01-01&end=2016-01-01&currency=XRP`,
        '/v2/exchanges/XRP/USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B?start=2013-01-01&end=2016-01-01',
      ]) {
        const res = await post({ path, format: 'csv' });
        expect([path, res.status, res.body.status]).toEqual([path, 202, 'queued']);
      }
    });

    it.each([
      ['no path', { format: 'csv' }, 'invalid path'],
      ['a path that is not /v2/…', { path: 'https://example.com/v2/accounts', format: 'csv' }, 'invalid path'],
      [
        'a list without a CSV form',
        { path: `/v2/accounts/${BUSY}/transactions/5`, format: 'csv' },
        'path is not exportable',
      ],
      ['a route that is no list', { path: '/v2/ledgers/11119600', format: 'csv' }, 'path is not exportable'],
      [
        'a route that does not exist',
        { path: '/v2/nope?start=2013-01-01&end=2016-01-01', format: 'csv' },
        'path is not exportable',
      ],
      [
        'a list over time without end',
        { path: transactions(BUSY, 'start=2013-01-01'), format: 'csv' },
        'start and end are required',
      ],
      [
        'a list over time without start',
        { path: transactions(BUSY, 'end=2016-01-01'), format: 'csv' },
        'start and end are required',
      ],
      ['no format', { path: transactions(BUSY, 'start=2013-01-01&end=2016-01-01') }, 'invalid format'],
      [
        'an unknown format',
        { path: transactions(BUSY, 'start=2013-01-01&end=2016-01-01'), format: 'xlsx' },
        'invalid format',
      ],
    ])('answers 400 for %s', async (_case, body, message) => {
      const res = await post(body);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message }]);
    });
  });

  describe('the exporter', () => {
    let worker: ExportWorker;

    beforeAll(async () => {
      // small pages, so that a list of 179 transactions takes 8 of them
      worker = new ExportWorker({
        ch: h.ch,
        storage,
        network: 'xrpl',
        apiUrl: await h.app.getUrl(),
        apiKey: EXPORTER_KEY,
        pageSize: 25,
        pollMs: 20,
        logger: { log: () => undefined, warn: () => undefined, error: (message: string) => console.error(message) },
      });
      worker.start();
    });

    afterAll(async () => {
      await worker?.stop();
    });

    /** The job once it is done or has failed. */
    const settled = async (id: string) => {
      for (let i = 0; i < 500; i++) {
        const res = await status(id);
        expect(res.status).toBe(200);
        if (res.body.status === 'done' || res.body.status === 'failed') return res.body;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`export ${id} did not finish`);
    };
    const exportOf = async (path: string) => {
      const res = await post({ path, format: 'csv' });
      expect([path, res.status]).toEqual([path, 202]);
      return settled(res.body.id);
    };
    const TIME = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    it('makes the file of the whole list: the CSV of the list, walked a page at a time', async () => {
      const path = transactions(BUSY, 'start=2013-01-01&end=2016-01-01&descending=true');
      const job = await exportOf(path);
      expect(job).toEqual({
        result: 'success',
        id: expect.any(String),
        status: 'done',
        format: 'csv',
        path,
        created: TIME,
        finished: TIME,
        rows: 179,
        url: expect.any(String),
      });

      // the same list in one page, as the route serves it
      const list = await h.http().get(`${path}&format=csv&limit=1000`).set('X-API-Key', TEST_API_KEY);
      expect(list.headers.link).toBeUndefined();
      const file = storage.download(job.url);
      expect(file.body).toBe(list.text);
      expect(file.body.split('\n')).toHaveLength(180);
      expect(file.contentType).toBe('text/csv');
      expect(file.contentDisposition).toBe(list.headers['content-disposition']);
    });

    it('gives a download link valid for 15 minutes', async () => {
      const job = await exportOf(transactions(BUSY, 'start=2015-01-14&end=2015-01-15'));
      expect(job.status).toBe('done');
      const before = Date.now();
      const again = await status(job.id);
      const expires = Number(/expires=(\d+)$/.exec(again.body.url)?.[1]);
      expect(expires - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
      expect(expires - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    });

    it('makes an empty file of an empty list', async () => {
      const job = await exportOf(transactions(BUSY, 'start=2030-01-01&end=2031-01-01'));
      expect([job.status, job.rows]).toEqual(['done', 0]);
      expect(storage.download(job.url).body).toBe('');
    });

    it('fails a job whose list answers an error, and says why', async () => {
      const path = transactions(BUSY, 'start=2013-01-01&end=2016-01-01&type=payment');
      const job = await exportOf(path);
      expect(job).toEqual({
        result: 'success',
        id: expect.any(String),
        status: 'failed',
        format: 'csv',
        path,
        created: TIME,
        finished: TIME,
        error: 'the list answered 400: invalid transaction type',
      });
    });
  });

  describe('the job of another key', () => {
    it('is not found, and neither is a job that does not exist', async () => {
      const res = await post({ path: transactions(BUSY, 'start=2013-01-01&end=2016-01-01'), format: 'csv' });
      expect(res.status).toBe(202);

      const other = await status(res.body.id, OTHER_KEY);
      expect([other.status, other.body]).toEqual([404, { result: 'error', message: 'export not found' }]);
      for (const id of ['0'.repeat(32), 'not-an-id']) {
        const missing = await status(id);
        expect([id, missing.status, missing.body]).toEqual([id, 404, { result: 'error', message: 'export not found' }]);
      }
      expect((await status(res.body.id)).status).toBe(200);
    });

    it('is not even seen with no key at all: the API key is required', async () => {
      const res = await post({ path: transactions(BUSY, 'start=2013-01-01&end=2016-01-01'), format: 'csv' });
      expect((await h.http().get(`/v2/exports/${res.body.id}`)).status).toBe(401);
      expect((await h.http().post('/v2/exports').send({})).status).toBe(401);
    });
  });
});
