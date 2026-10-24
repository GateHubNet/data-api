import { exportKeyHash, MemoryExportStorage, Table } from '@gatehub/data-api-shared';
import { ExportWorker } from '../../exporter/src/export-worker';
import { Harness, NO_RATE_LIMIT, startHarness, TEST_API_KEY } from './harness';
import { accountAt, hashOf } from './support/amm';
import { csvDisposition } from './support/csv';
import { pdfLines, pdfText, unwrapped } from './support/pdf';

/**
 * `POST /v2/exports` and `GET /v2/exports/{id}` (spec #4, ticket #15): an investigator asks for an export of a list and
 * fetches the file once it is done. The exporter of the network runs here against the same ClickHouse and this harness's
 * api, walking the list's pages over HTTP with its own key, and keeps the files in an in-memory store instead of Google
 * Cloud Storage. A PDF export (ticket #17) is checked by extracting its text: the header and the rows it should hold.
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
      // the jobs of these tests pile up queued: the limit per key has a spec of its own (export-limits.e2e-spec.ts)
      env: {
        ...NO_RATE_LIMIT,
        GH_API_KEYS: `${TEST_API_KEY},${OTHER_KEY},${EXPORTER_KEY}`,
        GH_NAMES_AND_LABELS_RELOAD_MS: '100',
        GH_EXPORT_MAX_JOBS_PER_KEY: '100',
      },
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

    it('takes the account transactions by sequence without start and end: the sequences are the window', async () => {
      for (const query of ['min_sequence=1', 'max_sequence=500', 'min_sequence=1&max_sequence=500']) {
        const res = await post({ path: transactions(BUSY, query), format: 'csv' });
        expect([query, res.status, res.body.status]).toEqual([query, 202, 'queued']);
      }
    });

    it('still asks a list over time for start and end when the sequences are empty', async () => {
      const res = await post({ path: transactions(BUSY, 'min_sequence=&max_sequence='), format: 'csv' });
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'start and end are required' }]);
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
    const exportOf = async (path: string, format = 'csv') => {
      const res = await post({ path, format });
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
    describe('in PDF', () => {
      /** The rows of a list as its CSV gives them, each an object keyed by column. */
      const csvRows = async (path: string) => {
        const res = await h.http().get(`${path}&format=csv&limit=1000`).set('X-API-Key', TEST_API_KEY);
        expect(res.headers.link).toBeUndefined();
        const [header, ...lines] = res.text.split('\n').map((line) => JSON.parse(`[${line}]`) as string[]);
        return lines.map((cells) => Object.fromEntries(header.map((column, i) => [column, cells[i]])));
      };
      /** The PDF file of a done export, and its text. */
      const pdfOf = async (url: string) => {
        const file = storage.download(url);
        return { file, ...(await pdfText(file.bytes)) };
      };

      it("makes a document of an account's list: a header that names the account, then the rows", async () => {
        // the mock ledgers do not activate the account: /v2/accounts/{address} answers for it with an activation
        await h.ch.insert(Table.AccountsCreated, [
          {
            account: BUSY,
            parent: accountAt(1),
            initial_balance: '20',
            ledger_index: 1000,
            tx_index: 0,
            tx_hash: hashOf(1000),
            inception: 1_300_000_000,
            genesis_balance: null,
            genesis_index: null,
          },
        ]);
        // the operator's names and labels of the address, read through /v2/accounts/{address} like the rows
        await h.ch.command(
          `INSERT INTO ${h.sharedDatabase}.account_names (address, name, added_by) VALUES ({a:String}, 'Busy Trader Ltd', 'ops')`,
          { a: BUSY },
        );
        await h.ch.command(
          `INSERT INTO ${h.database}.account_network_names (address, name, added_by) VALUES ({a:String}, 'Hot Wallet', 'ops')`,
          { a: BUSY },
        );
        await h.ch.command(
          `INSERT INTO ${h.sharedDatabase}.account_labels (address, label, description, source, url, added_by)
           VALUES ({a:String}, 'advisory', 'Listed by a regulator', 'FCA', 'https://example.com/list', 'ops')`,
          { a: BUSY },
        );
        for (let i = 0; ; i++) {
          const res = await h.http().get(`/v2/accounts/${BUSY}`).set('X-API-Key', TEST_API_KEY);
          expect(res.status).toBe(200);
          if ('account_labels' in res.body.account_data && 'account_network_name' in res.body.account_data) break;
          if (i > 200) throw new Error(`the names never showed: ${res.text}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        const path = transactions(BUSY, 'start=2013-01-01&end=2016-01-01&descending=true');
        const before = Date.now();
        const job = await exportOf(path, 'pdf');
        expect([job.status, job.format, job.rows]).toEqual(['done', 'pdf', 179]);

        const { file, pages, text } = await pdfOf(job.url);
        expect(file.contentType).toBe('application/pdf');
        expect(file.contentDisposition).toBe(csvDisposition(`${BUSY} - transactions`).replace(/\.csv/g, '.pdf'));
        // landscape A4 on every page
        expect(file.bytes.toString('latin1').match(/\/MediaBox \[[^\]]*\]/g)).toEqual(
          Array(pages).fill('/MediaBox [0 0 841.89 595.28]'),
        );

        const rows = await csvRows(path);
        const ledgers = rows.map((r) => Number(r.ledger_index));
        const lines = text.split('\n');
        for (const line of [
          `${BUSY} - transactions`,
          `Address: ${BUSY}`,
          'Account name: Busy Trader Ltd',
          'Account network name: Hot Wallet',
          'Label advisory: Listed by a regulator (FCA, https://example.com/list)',
          'Network: XRP Ledger',
          'Window: 2013-01-01 to 2016-01-01, newest first',
          `Ledgers: ${Math.min(...ledgers)} to ${Math.max(...ledgers)}`,
          'Rows: 179',
        ]) {
          expect(lines).toContain(line);
        }
        const made = /^Made: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)$/m.exec(text)?.[1];
        expect(Date.parse(made!)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
        expect(Date.parse(made!)).toBeLessThanOrEqual(Date.now());

        // the chosen columns of the account transactions, not every column of the CSV
        const flat = unwrapped(text);
        expect(flat).toContain(
          unwrapped(
            'ledger index executed time tx type result counterparty amount currency issuer fee flags changed hash',
          ),
        );
        expect(Object.keys(rows[0])).toContain('initiator');
        expect(text).not.toContain('initiator');

        // every row, in the order of the list, with its cells
        let at = 0;
        for (const row of rows) {
          const cells = unwrapped(
            [row.ledger_index, row.executed_time, row.tx_type, row.result, row.counterparty, row.amount].join(''),
          );
          const found = flat.indexOf(cells, at);
          expect([row.hash, found >= at]).toEqual([row.hash, true]);
          const hash = flat.indexOf(row.hash, found);
          expect([row.hash, hash > found]).toEqual([row.hash, true]);
          at = hash;
        }

        // page numbers, on a document of several pages
        expect(pages).toBeGreaterThan(1);
        for (let page = 1; page <= pages; page++) expect(lines).toContain(`Page ${page} of ${pages}`);
      });

      it('shows the first 8 columns of a list without chosen ones, and no account for a list of the network', async () => {
        const path = '/v2/exchanges/XRP/USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B?start=2013-01-01&end=2016-01-01';
        const job = await exportOf(path, 'pdf');
        const rows = await csvRows(path);
        expect([job.status, job.rows]).toEqual(['done', rows.length]);
        expect(rows.length).toBeGreaterThan(0);

        const { file, pages, text } = await pdfOf(job.url);
        expect(file.contentDisposition).toBe(csvDisposition('exchanges - XRP-USD').replace(/\.csv/g, '.pdf'));
        const lines = text.split('\n');
        expect(lines.filter((line) => /^(Address|Account name|Account network name|Label \w+):/.test(line))).toEqual(
          [],
        );
        expect(lines).toContain('Window: 2013-01-01 to 2016-01-01');
        expect(lines).toContain(`Rows: ${rows.length}`);

        const columns = Object.keys(rows[0]);
        expect(columns.length).toBeGreaterThan(8);
        const flat = unwrapped(text);
        expect(flat).toContain(unwrapped(columns.slice(0, 8).join('').replace(/_/g, '')));
        expect(flat).not.toContain(unwrapped(columns[8].replace(/_/g, '')));
        let at = 0;
        for (const row of rows) {
          const found = flat.indexOf(
            unwrapped(
              columns
                .slice(0, 8)
                .map((c) => row[c])
                .join(''),
            ),
            at,
          );
          expect([row, found >= at]).toEqual([row, true]);
          at = found + 1;
        }
        expect(lines).toContain(`Page ${pages} of ${pages}`);
      });

      it('makes a document of an empty list that says so', async () => {
        const job = await exportOf(transactions(BUSY, 'start=2030-01-01&end=2031-01-01'), 'pdf');
        expect([job.status, job.rows]).toEqual(['done', 0]);
        const { pages, text } = await pdfOf(job.url);
        const lines = text.split('\n');
        expect(pages).toBe(1);
        for (const line of [
          `Address: ${BUSY}`,
          'Rows: 0',
          'Ledgers: none (no rows)',
          'The list has no rows.',
          'Page 1 of 1',
        ]) {
          expect(lines).toContain(line);
        }
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

  describe('an exporter that starts', () => {
    it('fails every job a previous exporter left running, however many: they are read a batch at a time', async () => {
      const now = Date.now() / 1000;
      const ids = Array.from({ length: 250 }, (_, i) =>
        hashOf(1_000_000 + i)
          .slice(-32)
          .toLowerCase(),
      );
      const job = (id: string, seq: number, status: 'queued' | 'running') => ({
        id,
        seq,
        key_hash: exportKeyHash(TEST_API_KEY),
        path: transactions(BUSY, 'start=2013-01-01&end=2016-01-01'),
        format: 'csv',
        status,
        created: now,
        at: now + seq,
        rows: 0,
        object: '',
        error: '',
      });
      await h.ch.insert(Table.ExportJobs, [
        ...ids.map((id) => job(id, 0, 'queued')),
        ...ids.map((id) => job(id, 1, 'running')),
      ]);
      const worker = new ExportWorker({
        ch: h.ch,
        storage,
        network: 'xrpl',
        apiUrl: await h.app.getUrl(),
        apiKey: EXPORTER_KEY,
        pollMs: 20,
        logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      });
      worker.start();
      try {
        for (let i = 0; i < 500; i++) {
          const states = await Promise.all(ids.map(async (id) => (await status(id)).body));
          if (states.every((s) => s.status === 'failed')) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        await worker.stop();
      }
      for (const id of ids) {
        const res = await status(id);
        expect([id, res.body.status, res.body.error]).toEqual([
          id,
          'failed',
          'the exporter stopped while it made this export: ask for it again',
        ]);
      }
    });
  });
});

/**
 * An export of a list at a ledger whose path names none (`/balances`, `/trustlines`): the exporter resolves the ledger once,
 * the newest this api has indexed when it starts, and names it on every page it walks, so the file is that one ledger
 * even when a newer one is indexed in the middle of the walk; the PDF header says which ledger it is.
 *
 * The recorded mainnet ledgers of `xrpl/account-state`: the TUJ issuer's nine lines, walked two at a time. When the first
 * page of the walk has been served, a newer ledger is indexed that changes the issuer's last line.
 */
describe('exports of a list at a ledger that names none', () => {
  const TUJ_ISSUER = 'rKqSPjN6okYt7iPk3xzWvuW9oN1Nk7vSUV';
  const LAST_LINE = 'rhbj4x2i7hiwoWb7vQZ16XmnAKPcLtepDX';
  /** The newest recorded ledger: the newest indexed one when the exports below start. */
  const NEWEST = 107872958;
  const storage = new MemoryExportStorage();
  let h: Harness;
  let worker: ExportWorker;
  /** Told about every request of the exporter once it is answered. */
  let answered: ((url: string) => Promise<void>) | undefined;

  beforeAll(async () => {
    h = await startHarness({
      seed: 'xrpl-account-state',
      exportStorage: storage,
      env: { ...NO_RATE_LIMIT, GH_API_KEYS: `${TEST_API_KEY},${EXPORTER_KEY}`, GH_EXPORT_MAX_JOBS_PER_KEY: '100' },
    });
    // the issuer's native balance at the newest ledger, for /balances (the recorded ledgers do not change its root)
    await h.ch.insert(Table.AccountStates, [
      {
        account: TUJ_ISSUER,
        ledger_index: NEWEST,
        tx_index: 0,
        node_index: 0,
        tx_hash: hashOf(1),
        close_time: 1_792_851_440,
        balance: '42',
        flags: 0,
        sequence: 1,
        owner_count: 0,
        fields: '{}',
        deleted: 0,
      },
    ]);
    worker = new ExportWorker({
      ch: h.ch,
      storage,
      network: 'xrpl',
      apiUrl: await h.app.getUrl(),
      apiKey: EXPORTER_KEY,
      pageSize: 2,
      pollMs: 20,
      logger: { log: () => undefined, warn: () => undefined, error: (message: string) => console.error(message) },
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        await answered?.(String(input));
        return res;
      },
    });
    worker.start();
  });

  afterAll(async () => {
    await worker?.stop();
    await h?.close();
  });

  const get = (path: string) => h.http().get(path).set('X-API-Key', TEST_API_KEY);
  const exportOf = async (path: string, format: string) => {
    const res = await h.http().post('/v2/exports').set('X-API-Key', TEST_API_KEY).send({ path, format });
    expect([path, res.status]).toEqual([path, 202]);
    for (let i = 0; i < 500; i++) {
      const job = await get(`/v2/exports/${res.body.id}`);
      if (job.body.status === 'done' || job.body.status === 'failed') return job.body;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`export ${res.body.id} did not finish`);
  };

  /** Indexes ledger `NEWEST + 1`, in which the issuer's last line changes its balance. */
  const indexNewerLedger = async () => {
    await h.ch.command(
      `INSERT INTO ${Table.Ledgers}
       SELECT tpl.* REPLACE (toUInt32({ledger:UInt32}) AS ledger_index, {hash:String} AS ledger_hash)
         FROM (SELECT * FROM ${Table.Ledgers} WHERE ledger_index = {newest:UInt32} LIMIT 1) AS tpl`,
      { ledger: NEWEST + 1, newest: NEWEST, hash: hashOf(NEWEST + 1) },
    );
    await h.ch.command(
      `INSERT INTO ${Table.TrustLineStates}
       SELECT tpl.* REPLACE (toUInt32({ledger:UInt32}) AS ledger_index, '-1' AS balance)
         FROM (SELECT * FROM ${Table.TrustLineStates}
                WHERE account = {issuer:String} AND counterparty = {peer:String} AND currency = 'TUJ'
                ORDER BY ledger_index DESC LIMIT 1) AS tpl`,
      { ledger: NEWEST + 1, issuer: TUJ_ISSUER, peer: LAST_LINE },
    );
  };

  it('a CSV of /trustlines is the lines at the ledger the walk started at, page after page', async () => {
    const path = `/v2/accounts/${TUJ_ISSUER}/trustlines`;
    // the newer ledger is indexed once the first page of the walk has been served
    let indexed = false;
    answered = async (url) => {
      if (indexed || !url.includes(`${path}?`) || !url.includes('format=csv')) return;
      indexed = true;
      await indexNewerLedger();
    };
    let job;
    try {
      job = await exportOf(path, 'csv');
    } finally {
      answered = undefined;
    }
    expect(indexed).toBe(true);
    expect([job.status, job.rows, job.error]).toEqual(['done', 9, undefined]);

    const at = (ledger: number) => get(`${path}?ledger_index=${ledger}&format=csv&limit=1000`);
    const [started, newer] = await Promise.all([at(NEWEST), at(NEWEST + 1)]);
    // the newer ledger did change the list
    expect(newer.text).not.toBe(started.text);
    expect(storage.download(job.url).body).toBe(started.text);
  });

  it('a PDF of /trustlines says in its header the ledger it is at', async () => {
    const job = await exportOf(`/v2/accounts/${TUJ_ISSUER}/trustlines`, 'pdf');
    expect(job.status).toBe('done');
    expect(pdfLines(storage.download(job.url).bytes)).toContain(
      `At: ledger ${NEWEST + 1}, the newest indexed when the export was made`,
    );
  });

  it('a CSV of /balances is the balances at the newest indexed ledger, from the state history and not the node', async () => {
    const path = `/v2/accounts/${TUJ_ISSUER}/balances`;
    const job = await exportOf(path, 'csv');
    // the list has no marker: the export reads it whole with limit=all, not one page of the exporter's size (2 here)
    expect([job.status, job.error, job.rows]).toEqual(['done', undefined, 10]);
    const expected = await get(`${path}?ledger_index=${NEWEST + 1}&format=csv&limit=all`);
    expect(expected.status).toBe(200);
    expect(expected.text.split('\n')).toHaveLength(11);
    expect(storage.download(job.url).body).toBe(expected.text);
  });

  it('fails an export of a list that neither pages nor takes limit=all, rather than cut it at its limit', async () => {
    const path = `/v2/accounts/${TUJ_ISSUER}/analytics/counterparties?start=2015-01-01&end=2027-01-01`;
    const job = await exportOf(path, 'csv');
    expect([job.status, job.error, job.url]).toEqual([
      'failed',
      'the list has no pages and cannot be read whole (no marker, no limit=all): an export would cut it at its limit',
      undefined,
    ]);
  });

  it('a path that names a ledger, or a list over time, keeps what it names', async () => {
    const path = `/v2/accounts/${TUJ_ISSUER}/trustlines?ledger_index=93663334`;
    const job = await exportOf(path, 'pdf');
    expect(job.status).toBe('done');
    expect(pdfLines(storage.download(job.url).bytes)).toContain('At: ledger 93663334');
  });
});
