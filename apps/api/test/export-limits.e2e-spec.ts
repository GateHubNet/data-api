import { MemoryExportStorage } from '@gatehub/data-api-shared';
import { ExportWorker } from '../../exporter/src/export-worker';
import { Harness, NO_RATE_LIMIT, startHarness, TEST_API_KEY } from './harness';

/**
 * The limits of exports (spec #4, ticket #16): at most three queued or running exports per API key, and a row cap per
 * format. The caps are set small here (`GH_EXPORT_MAX_ROWS_*`) so that the mock ledgers exceed them. The exporter of the
 * network takes one job at a time when a test asks it to (`runNext`), so that a test knows which jobs are still queued.
 */

const BUSY = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q'; // 179 transactions in the mock ledgers, one of them in February 2015
/** 42 transactions in the mock ledgers: 23 payments, 14 offers created and 5 cancelled. */
const MIXED = 'rBQkEKFMnBjc19DRaY7ThLJ2woqQManbTt';
/** 46 transactions in the mock ledgers, 45 of them sent by the account, 3 of those failed payments. */
const SENDER = 'rJAeQMhtr89PvFPnAZXkdgJgScZ1YuB9UR';
/** Accounts with 59, 23 and 21 payments in the mock ledgers. */
const PAYING = [
  'rwvLbHQtU16BwQJyrQb9cfFKvx13Ksbkja',
  'r4L6ZLHkTytPqDR81H1ysCr6qGv9oJJAKi',
  'rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj',
];
const OTHER_KEY = 'other-key';
const EXPORTER_KEY = 'exporter-key';
const transactions = (address: string, query: string) => `/v2/accounts/${address}/transactions?${query}`;
const WINDOW = 'start=2013-01-01&end=2018-01-01';
/** A list of one row. */
const SHORT = transactions(BUSY, 'start=2015-02-01&end=2015-03-01');
const payments = (address: string) => `/v2/accounts/${address}/payments?${WINDOW}`;
/** The caps of this harness, for the api and its exporter alike. */
const CSV_CAP = 23;
const PDF_CAP = 5;

describe('export limits', () => {
  let h: Harness;
  let worker: ExportWorker;
  const storage = new MemoryExportStorage();

  beforeAll(async () => {
    h = await startHarness({
      seed: 'ripple-mock',
      exportStorage: storage,
      env: {
        ...NO_RATE_LIMIT,
        GH_API_KEYS: `${TEST_API_KEY},${OTHER_KEY},${EXPORTER_KEY}`,
        GH_EXPORT_MAX_ROWS_CSV: String(CSV_CAP),
        GH_EXPORT_MAX_ROWS_PDF: String(PDF_CAP),
      },
    });
    worker = new ExportWorker({
      ch: h.ch,
      storage,
      network: 'xrpl',
      apiUrl: await h.app.getUrl(),
      apiKey: EXPORTER_KEY,
      maxRows: { csv: CSV_CAP, pdf: PDF_CAP },
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
      const path = SHORT;
      for (let i = 0; i < 3; i++) expect((await post({ path, format: 'csv' })).status).toBe(202);

      const fourth = await post({ path, format: 'csv' });
      expect([fourth.status, fourth.body]).toEqual([
        429,
        { result: 'error', message: 'too many exports in progress: at most 3 per API key' },
      ]);
      expect((await post({ path, format: 'csv' }, OTHER_KEY)).status).toBe(202);
    });

    it('takes a new one once an export of the key is done', async () => {
      const path = SHORT;
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await post({ path, format: 'csv' })).body.id);
      expect((await post({ path, format: 'csv' })).status).toBe(429);

      expect(await worker.runNext()).toBe(true);
      expect((await status(ids[0])).body.status).toBe('done');
      expect((await post({ path, format: 'csv' })).status).toBe(202);
    });

    it('takes a new one once an export of the key has failed', async () => {
      const failing = transactions(BUSY, `${WINDOW}&type=payment`); // the list answers 400 to this type
      const path = SHORT;
      const id = (await post({ path: failing, format: 'csv' })).body.id;
      for (let i = 0; i < 2; i++) expect((await post({ path, format: 'csv' })).status).toBe(202);
      expect((await post({ path, format: 'csv' })).status).toBe(429);

      expect(await worker.runNext()).toBe(true);
      expect((await status(id)).body.status).toBe('failed');
      expect((await post({ path, format: 'csv' })).status).toBe(202);
    });
  });

  describe('the row cap', () => {
    /** The job once the exporter has made it. */
    const made = async (path: string, format = 'csv') => {
      const res = await post({ path, format });
      expect([path, res.status]).toEqual([path, 202]);
      await drain();
      return (await status(res.body.id)).body;
    };
    /** The rows of the list, as the route serves it in one page. */
    const rowsOf = async (path: string) => {
      const res = await h.http().get(`${path}&format=csv&limit=1000`).set('X-API-Key', TEST_API_KEY);
      expect([res.status, res.headers.link]).toEqual([200, undefined]);
      return res.text === '' ? 0 : res.text.split('\n').length - 1;
    };

    it('fails an export whose list turns out longer than the cap of CSV, and says to narrow the window', async () => {
      const path = payments(PAYING[0]);
      expect(await rowsOf(path)).toBeGreaterThan(CSV_CAP);
      const job = await made(path);
      expect([job.status, job.error, job.url]).toEqual([
        'failed',
        `the list has more than ${CSV_CAP} rows, the most a CSV export holds: narrow the window`,
        undefined,
      ]);
    });

    it('makes the file of a list at the cap, or below it', async () => {
      for (const address of PAYING.slice(1)) {
        const path = payments(address);
        const rows = await rowsOf(path);
        expect(rows).toBeLessThanOrEqual(CSV_CAP);
        const job = await made(path);
        expect([address, job.status, job.rows]).toEqual([address, 'done', rows]);
      }
      expect(await rowsOf(payments(PAYING[1]))).toBe(CSV_CAP);
    });

    it('refuses up front an export of account transactions above the cap of CSV, and says to narrow the window', async () => {
      const path = transactions(BUSY, WINDOW);
      expect(await rowsOf(path)).toBeGreaterThan(CSV_CAP);
      const res = await post({ path, format: 'csv' });
      expect([res.status, res.body]).toEqual([
        400,
        {
          result: 'error',
          message: `the list has more than ${CSV_CAP} rows, the most a CSV export holds: narrow the window`,
        },
      ]);
    });

    it.each([
      ['every transaction of the account', MIXED, '', 42, 400],
      ['its payments: as many as the cap', MIXED, '&type=Payment', 23, 202],
      ['its offers', MIXED, '&type=OfferCreate', 14, 202],
      ['its failed payments', SENDER, '&type=Payment&result=tecPATH_DRY', 3, 202],
    ])(
      'counts account transactions up front as the list serves them: %s',
      async (_case, address, filter, rows, code) => {
        const path = transactions(address, `${WINDOW}${filter}`);
        expect(await rowsOf(path)).toBe(rows);
        const res = await post({ path, format: 'csv' });
        expect(res.status).toBe(code);
        await drain();
      },
    );

    it.each([
      ['the path payments of the network', `/v2/path_payments?${WINDOW}`, 'csv', 61, 400],
      [
        'the path payments of an account above the cap',
        `/v2/accounts/${PAYING[0]}/path_payments?${WINDOW}`,
        'csv',
        57,
        400,
      ],
      [
        'the path payments of an account at the cap',
        `/v2/accounts/${PAYING[1]}/path_payments?${WINDOW}`,
        'csv',
        23,
        202,
      ],
      ['the same in PDF, above its cap', `/v2/accounts/${PAYING[1]}/path_payments?${WINDOW}`, 'pdf', 23, 400],
      ['a window without ledgers', '/v2/path_payments?start=2030-01-01&end=2031-01-01', 'pdf', 0, 202],
    ])(
      'counts path payments up front by window, as the list serves them: %s',
      async (_case, path, format, rows, code) => {
        expect(await rowsOf(path)).toBe(rows);
        const res = await post({ path, format });
        expect([res.status, res.body.message]).toEqual([
          code,
          code === 400
            ? `the list has more than ${format === 'csv' ? CSV_CAP : PDF_CAP} rows, ${
                format === 'csv'
                  ? 'the most a CSV export holds: narrow the window'
                  : 'the most a PDF export holds: narrow the window or use CSV'
              }`
            : undefined,
        ]);
        await drain();
      },
    );

    it('does not count the list by sequence up front: the exporter holds it to the cap', async () => {
      const path = transactions(SENDER, `${WINDOW}&min_sequence=1`);
      expect(await rowsOf(path)).toBeGreaterThan(CSV_CAP);
      const job = await made(path);
      expect([job.status, job.error]).toEqual([
        'failed',
        `the list has more than ${CSV_CAP} rows, the most a CSV export holds: narrow the window`,
      ]);
    });

    it('refuses up front an export in PDF above its cap, and says to narrow the window or use CSV', async () => {
      const path = transactions(MIXED, `${WINDOW}&type=OfferCreate`);
      expect(await rowsOf(path)).toBeGreaterThan(PDF_CAP);
      const res = await post({ path, format: 'pdf' });
      expect([res.status, res.body]).toEqual([
        400,
        {
          result: 'error',
          message: `the list has more than ${PDF_CAP} rows, the most a PDF export holds: narrow the window or use CSV`,
        },
      ]);
    });

    it('fails an export in PDF whose list turns out longer than its cap, and says to use CSV', async () => {
      const path = payments(PAYING[2]);
      expect(await rowsOf(path)).toBeGreaterThan(PDF_CAP);
      const job = await made(path, 'pdf');
      expect([job.status, job.error]).toEqual([
        'failed',
        `the list has more than ${PDF_CAP} rows, the most a PDF export holds: narrow the window or use CSV`,
      ]);
    });
  });
});
