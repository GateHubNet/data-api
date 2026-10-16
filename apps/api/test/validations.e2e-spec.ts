import { Table, ValidationsRow } from '@gatehub/data-api-shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';

/**
 * `GET /v2/ledgers/:ledger_hash/validations[/:pubkey]` (and the singular `/v2/ledger/...`) on a real ClickHouse, seeded
 * with `test/mock/ledger-validations.json` of the original Ripple test suite, which the original loaded straight into HBase
 * (`validations_by_ledger`) and this spec writes straight into `validations`.
 *
 * The 7 mock rows are 4 validators: the original kept a row per (ledger, validator, SECOND of the first sighting), plus
 * rows of its first collector (no date in the key: `main`, `reporting_node`, `type`, `time`) for three of them. Here every
 * row is a partial sighting of `validations` (an AggregatingMergeTree), the legacy `reporting_node` is the reporter and
 * `main`/`type`/`time` have no column, and a validation is what `GROUP BY (ledger_hash, validation_public_key)` makes of
 * them: 4, with the counts of their rows added up, the first of the first datetimes and the last of the last.
 *
 * The times of the mock (2019-03-26) are moved to yesterday, keeping the time of day: `validations` expires its rows 90 days
 * after their last datetime (TTL) and ClickHouse drops an expired row as it is written.
 *
 * Ported from rippled-historical-database `test/test.validations.js`, `describe('ledger validations')` (7 `it`s), same
 * titles, none skipped; changed:
 *  - 'should get ledger validations' expected 7 (the 7 HBase rows); it is 4 validators here, which is what one row per
 *    validator is (see above);
 *  - 'should handle /ledgers/:hash/validations pagination' pages with `limit=1` as `utils.checkPagination` did, and compares
 *    the signatures with the unpaged list;
 *  - 'should include a link header when marker is present' expected the HBase row key (`<hash>|<pubkey>`) of the FIRST row
 *    of the next page as the marker; the marker of this API is, like every other list of this API, the base64url of a JSON
 *    array holding the key of the LAST row of the page: `["<pubkey>"]`.
 * Not ported: the other `describe`s of that file (`validator reports`, `validators`: `/v2/network/validator_reports`,
 * `/v2/network/validators[/:pubkey[/reports]]`, which this task does not serve), and the `setup mock data` step (HBase).
 *
 * Added: the shape of a validation (R73: the keys in the order of the HBase row, text values, `count` a number, empty
 * columns left out), the key and the CSV header pinned, the hash rules (R72), limits, pages by validator key (R74),
 * the singular alias, the single-validation route, CSV, rows written in pieces (real partial rows: merges stopped, a
 * SECOND insert), the plan of the queries, failures, Xahau.
 */

// -- helpers ----------------------------------------------------------------------------------------------------

/**
 * The rows of `validations` expire 90 days after their `last_datetime` (TTL), and ClickHouse drops an expired row as it is
 * written, so a test cannot seed the 2019 times of the mock. They are moved to yesterday (UTC), keeping the time of day;
 * every other time of this spec is yesterday too.
 */
const dayOf = (ago: number): string => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
const YESTERDAY = dayOf(1);
const DAY_BEFORE = dayOf(2);
/** `2019-03-26T16:45:20.466Z` -> `<yesterday>T16:45:20.466Z`. */
const onYesterday = (iso: string): string => `${YESTERDAY}T${iso.slice(11)}`;

const H = '9373383605D0994AF33ACECA206693B331BA61C3CDA511AF3E7DD569593E126C';
const K1 = 'nHUkhmyFPr3vEN3C8yfhKp4pu4t3wkTCi2KEDBWhyMNpsMj2HbnD';
const K2 = 'nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6';
const K3 = 'nHUnhRJK3csknycNK5SXRFi8jvDp3sKoWvS9wKWLq1ATBBGgPBjp';
const K4 = 'nHUon2tpyJEHHYGmxqeGu37cvPYHzrMtUNQFVdCgGNvEkjmCpTqK';
const KEYS = [K1, K2, K3, K4];

/** The marker of a row: its validator key as base64url JSON. */
const markerOf = (key: string): string => Buffer.from(JSON.stringify([key]), 'utf8').toString('base64url');
/** `?a=1&b=2`, encoded. */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

interface MockRow {
  rowkey: string;
  count: string;
  first_datetime: string;
  last_datetime: string;
  ledger_hash: string;
  ledger_index: string;
  validation_public_key: string;
  reporter_public_key?: string;
  reporting_node?: string;
  ephemeral_public_key?: string;
  signature: string;
  signing_time: string;
  flags: string;
  full: string;
}

const MOCK = JSON.parse(readFileSync(join(__dirname, 'support', 'ledger-validations.json'), 'utf8')) as MockRow[];

/** A mock row as the partial sighting `validations` stores: the strings of HBase turned into the columns' types. */
function sighting(row: MockRow): ValidationsRow {
  return {
    ledger_hash: row.ledger_hash,
    validation_public_key: row.validation_public_key,
    count: Number(row.count),
    first_datetime: Date.parse(onYesterday(row.first_datetime)) / 1000,
    last_datetime: Date.parse(onYesterday(row.last_datetime)) / 1000,
    ledger_index: Number(row.ledger_index),
    reporter_public_key: row.reporter_public_key ?? row.reporting_node ?? '',
    ephemeral_public_key: row.ephemeral_public_key ?? '',
    signature: row.signature,
    signing_time: Number(row.signing_time),
    flags: Number(row.flags),
    full: row.full === 'true' ? 1 : 0,
    amendments: '',
    base_fee: null,
    load_fee: null,
    reserve_base: null,
    reserve_inc: null,
  };
}

/** A sighting of anything, for the tests that need rows of their own. */
function row(overrides: Partial<ValidationsRow> = {}): ValidationsRow {
  return {
    ledger_hash: H,
    validation_public_key: K1,
    count: 1,
    first_datetime: Date.parse(`${YESTERDAY}T12:00:00.123Z`) / 1000,
    last_datetime: Date.parse(`${YESTERDAY}T12:00:00.123Z`) / 1000,
    ledger_index: 100,
    reporter_public_key: 'n9Reporter',
    ephemeral_public_key: 'n9Ephemeral',
    signature: 'AA',
    signing_time: 1,
    flags: 2147483649,
    full: 1,
    amendments: '',
    base_fee: null,
    load_fee: null,
    reserve_base: null,
    reserve_inc: null,
    ...overrides,
  };
}

/**
 * What the 7 mock rows are as 4 validations, worked out by hand from `ledger-validations.json` (not through the code under
 * test): the counts of a validator's rows added up (57 + 58, 8 + 8, 57 + 58), the first of the first datetimes (the legacy
 * row's, a second earlier than the dated row's), the last of the last, and the other fields of the earliest row.
 */
const EXPECTED = [
  {
    count: 13,
    first_datetime: `${YESTERDAY}T16:45:20.466Z`,
    flags: '2147483649',
    full: 'true',
    last_datetime: `${YESTERDAY}T16:45:20.549Z`,
    ledger_hash: H,
    ledger_index: '46087342',
    reporter_public_key: 'n9KJb7NMxGySRcjCqh69xEPMUhwJx22qntYYXsnUqYgjsJhNoW7g',
    signature:
      '3045022100E4634BA5564315989B60E6FC51E3CFF44EB1263668EAF89FF04B07F31735F07D0220786FBF51B820A07553B075E27B1C67D11406F272D215A48B283D98DF09104B31',
    signing_time: '606933920',
    validation_public_key: K1,
  },
  {
    count: 115,
    ephemeral_public_key: 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy',
    first_datetime: `${YESTERDAY}T16:45:20.000Z`,
    flags: '2147483649',
    full: 'true',
    last_datetime: `${YESTERDAY}T16:45:20.654Z`,
    ledger_hash: H,
    ledger_index: '46087342',
    reporter_public_key: 'n9JjkhXeW9G9wbnD24CjWj57mBNYzvyaKpVczHRmfm3U5Y7XRsvP',
    signature:
      '304402207D80F93D2C184D6ACBE543DF71586DE0326684ECC8F1CCC927899717C3F6F7CF022013105248E34F0A0DBDD1ED437F49CBBFB39BC65EC11E07F45A6CD1418F9B9244',
    signing_time: '606933920',
    validation_public_key: K2,
  },
  {
    count: 16,
    ephemeral_public_key: 'n9LbDLg9F7ExZCeMw1QZqsd1Ejs9uYpwd8bPUStF5hBJdd6B5aWj',
    first_datetime: `${YESTERDAY}T16:45:19.000Z`,
    flags: '2147483649',
    full: 'true',
    last_datetime: `${YESTERDAY}T16:45:19.733Z`,
    ledger_hash: H,
    ledger_index: '46087342',
    reporter_public_key: 'n9KA51bSzH4z9vt2vrV67cN5kNoJnhgv7TdajK5i7Z2wsfRsJKps',
    signature:
      '3045022100855766D5092AA69DEA82D2D7E180667AE6B1B89319F450B65127168F67489F4A02201E621D3B757E6252ECE4AEECDB63B45385A58CA29E68F4D25CE62636A3680E58',
    signing_time: '606933919',
    validation_public_key: K3,
  },
  {
    count: 115,
    ephemeral_public_key: 'n9JebyUXwBa5GoYJQ6AbupoMKyE2zaiR3FTfDTMkxpMMv1KPmQEn',
    first_datetime: `${YESTERDAY}T16:45:20.000Z`,
    flags: '2147483649',
    full: 'true',
    last_datetime: `${YESTERDAY}T16:45:20.386Z`,
    ledger_hash: H,
    ledger_index: '46087342',
    reporter_public_key: 'n9JySgyBVcQKvyDoeRKg7s2Mm6ZcFHk22vUZb3o1HSosWxcj9xPt',
    signature:
      '304402204082FBD7CA0E61E01E68D0F5EF5FEB372AF0F99C75C58927D56B1975CD6E13CE02202A719507403AF1E8002314DDABA732822358D9E30051EA4325884D6338D23CEB',
    signing_time: '606933920',
    validation_public_key: K4,
  },
];

/** The keys of a validation that has every column the mock rows have, in the order of the HBase row (R73). */
const MOCK_KEYS = [
  'count',
  'ephemeral_public_key',
  'first_datetime',
  'flags',
  'full',
  'last_datetime',
  'ledger_hash',
  'ledger_index',
  'reporter_public_key',
  'signature',
  'signing_time',
  'validation_public_key',
];

interface ListBody {
  result: string;
  ledger_hash: string;
  count: number;
  marker?: string;
  validations: Record<string, unknown>[];
}

// ===================================================================================================================
// the original's tests
// ===================================================================================================================

describe('ledger validations (the original test.validations.js)', () => {
  let h: Harness;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
    // separate inserts, as the original's rows were separate rows: the table adds them up
    for (const mock of MOCK) await h.ch.insert(Table.Validations, [sighting(mock)]);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('should get ledger validations', async () => {
    const res = await get(`/v2/ledgers/${H}/validations`);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.body.ledger_hash).toBe(H);
    // the original had 7 rows (a row per second of the first sighting, and the rows of its first collector): 4 validators
    expect(res.body.validations).toHaveLength(4);
    expect(res.body.count).toBe(4);
    (res.body as ListBody).validations.forEach((d) => {
      expect(d.ledger_hash).toBe(H);
    });
  });

  it('should handle /ledgers/:hash/validations pagination', async () => {
    const ref = (await get(`/v2/ledgers/${H}/validations`)).body as ListBody;
    expect(ref.count).toBeGreaterThan(1); // utils.checkPagination: must be at least 2
    let marker: string | undefined;
    for (let i = 0; i < ref.count; i += 1) {
      const res = await get(`/v2/ledgers/${H}/validations?limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.validations).toHaveLength(1);
      expect(res.body.validations[0].signature).toEqual(ref.validations[i].signature);
      marker = res.body.marker;
    }
    expect(marker).toBeUndefined(); // the last page has no marker
  });

  it('should include a link header when marker is present', async () => {
    const res = await get(`/v2/ledgers/${H}/validations?limit=1`);
    expect(res.status).toBe(200);
    const origin = new URL(res.request.url).origin;
    // the original's marker was the row key of the next validator; here it is the key of the last row of the page
    expect(res.body.marker).toBe(markerOf(K1));
    expect(res.headers.link).toBe(`<${origin}/v2/ledgers/${H}/validations?limit=1&marker=${markerOf(K1)}>; rel="next"`);
  });

  it('should get ledger validations in CSV format', async () => {
    const res = await get(`/v2/ledgers/${H}/validations?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename=${H} - validations.csv`);
  });

  it('should get a specific ledger validation', async () => {
    const res = await get(`/v2/ledgers/${H}/validations/${K1}`);
    expect(res.status).toBe(200);
    expect(res.body.ledger_hash).toBe(H);
    expect(res.body.validation_public_key).toBe(K1);
  });

  it('should error on an invalid ledger hash', async () => {
    const res = await get('/v2/ledgers/zzz/validations?format=csv');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid ledger hash');
  });

  it('should error on validation not found', async () => {
    const res = await get(`/v2/ledgers/${H}/validations/abcd`);
    expect(res.status).toBe(404);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('validation not found');
  });
});

// ===================================================================================================================
// the routes
// ===================================================================================================================

describe('GET /v2/ledgers/:ledger_hash/validations', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    for (const mock of MOCK) await h.ch.insert(Table.Validations, [sighting(mock)]);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the shape', () => {
    it('is {result, ledger_hash, count, validations}, with no marker on the last page', async () => {
      const res = await get(`/v2/ledgers/${H}/validations`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(Object.keys(res.body)).toEqual(['result', 'ledger_hash', 'count', 'validations']);
      expect(res.body.result).toBe('success');
    });

    it('serves the validations of the mock ledger, one per validator, sorted by validator key', async () => {
      const res = await get(`/v2/ledgers/${H}/validations`);
      expect(res.body.validations).toEqual(EXPECTED);
      expect((res.body as ListBody).validations.map((v) => v.validation_public_key)).toEqual([...KEYS].sort());
    });

    it('R73: Object.keys of a validation are the columns of the HBase row, sorted by name', async () => {
      const res = await get(`/v2/ledgers/${H}/validations`);
      const keys = (res.body as ListBody).validations.map((v) => Object.keys(v));
      // the first validator has no ephemeral key (the original's row for it had none)
      expect(keys[0]).toEqual(MOCK_KEYS.filter((k) => k !== 'ephemeral_public_key'));
      for (const k of keys.slice(1)) expect(k).toEqual(MOCK_KEYS);
      for (const k of keys) expect(k).toEqual([...k].sort()); // sorted by byte order, which is what HBase did
    });

    it('serves count as a number and everything else as text, as the original did', async () => {
      const [v] = (await get(`/v2/ledgers/${H}/validations`)).body.validations as Record<string, unknown>[];
      expect(typeof v.count).toBe('number');
      for (const [key, value] of Object.entries(v)) {
        if (key !== 'count') expect([key, typeof value]).toEqual([key, 'string']);
      }
      expect(v.flags).toBe('2147483649');
      expect(v.full).toBe('true');
      expect(v.ledger_index).toBe('46087342');
      expect(v.signing_time).toBe('606933920');
    });

    it('writes the datetimes as YYYY-MM-DDTHH:mm:ss.SSSZ', async () => {
      const res = await get(`/v2/ledgers/${H}/validations`);
      for (const v of (res.body as ListBody).validations) {
        expect(v.first_datetime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        expect(v.last_datetime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        expect(Date.parse(String(v.last_datetime))).toBeGreaterThanOrEqual(Date.parse(String(v.first_datetime)));
      }
    });

    it('adds up the partial rows of a validation: sum of counts, earliest first, latest last (115 = 57 + 58)', async () => {
      const [, v2] = (await get(`/v2/ledgers/${H}/validations`)).body.validations as Record<string, unknown>[];
      expect(v2).toMatchObject({
        validation_public_key: K2,
        count: 115,
        first_datetime: `${YESTERDAY}T16:45:20.000Z`,
        last_datetime: `${YESTERDAY}T16:45:20.654Z`,
      });
    });

    it('ignores unknown parameters, and the first value of a repeated one wins', async () => {
      const plain = (await get(`/v2/ledgers/${H}/validations`)).body;
      expect((await get(`/v2/ledgers/${H}/validations?foo=bar&descending=true&start=2030-01-01`)).body).toEqual(plain);
      const repeated = await get(`/v2/ledgers/${H}/validations?limit=1&limit=3`);
      expect(repeated.body.count).toBe(1);
      expect(repeated.headers.link).toContain('limit=1&marker=');
    });

    it('has a ledger without validations: count 0, an empty list, 200', async () => {
      const res = await get(`/v2/ledgers/${'AB'.repeat(32)}/validations`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: 'success', ledger_hash: 'AB'.repeat(32), count: 0, validations: [] });
      expect(res.headers.link).toBeUndefined();
    });
  });

  describe('the ledger hash', () => {
    it('is upper-cased: the ledger_hash of the answer, and its validations, are the same for any case', async () => {
      const upper = await get(`/v2/ledgers/${H}/validations`);
      const lower = await get(`/v2/ledgers/${H.toLowerCase()}/validations`);
      expect(lower.status).toBe(200);
      expect(lower.body).toEqual(upper.body);
      expect(lower.body.ledger_hash).toBe(H);
    });

    it('may start with 0x, which is dropped (the original upper-cased it to 0X... and found nothing)', async () => {
      for (const prefixed of [`0x${H}`, `0x${H.toLowerCase()}`]) {
        const res = await get(`/v2/ledgers/${prefixed}/validations`);
        expect([prefixed, res.status, res.body.ledger_hash, res.body.count]).toEqual([prefixed, 200, H, 4]);
      }
      const one = await get(`/v2/ledgers/0x${H}/validations/${K1}`);
      expect(one.status).toBe(200);
      expect(one.body.ledger_hash).toBe(H);
    });

    it('answers 400 invalid ledger hash for odd length, non-hex text, 0X, a bare 0x', async () => {
      for (const bad of [
        H.slice(1),
        `${H}0`,
        'zzz',
        `${H.slice(2)}zz`,
        `0X${H}`,
        '0x',
        `0x${H.slice(1)}`,
        'ab-cd',
        'ab%20cd',
      ]) {
        for (const route of [`/v2/ledgers/${bad}/validations`, `/v2/ledgers/${bad}/validations/${K1}`]) {
          const res = await get(route);
          expect([route, res.status, res.body]).toEqual([
            route,
            400,
            { result: 'error', message: 'invalid ledger hash' },
          ]);
        }
      }
    });

    it('is matched exactly: a prefix of a hash finds nothing (the original scanned by prefix)', async () => {
      const res = await get(`/v2/ledgers/${H.slice(0, 8)}/validations`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
    });

    it('is checked before anything else, whatever else is wrong with the request', async () => {
      const res = await get('/v2/ledgers/zzz/validations?limit=abc&marker=!!!');
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('invalid ledger hash');
    });
  });

  describe('limit and marker', () => {
    it('limit: 200 by default; below 1, not a number, or empty is the default; a decimal is cut', async () => {
      for (const limit of ['0', '-5', 'abc', '', 'NaN']) {
        const res = await get(`/v2/ledgers/${H}/validations?limit=${limit}`);
        expect([limit, res.status, res.body.count]).toEqual([limit, 200, 4]);
      }
      expect((await get(`/v2/ledgers/${H}/validations?limit=2.9`)).body.count).toBe(2);
      expect((await get(`/v2/ledgers/${H}/validations?limit=2`)).body.count).toBe(2);
    });

    it('pages by validator key: the pages concatenate to the unpaged list, for any page size', async () => {
      const unpaged = (await get(`/v2/ledgers/${H}/validations`)).body as ListBody;
      for (const limit of [1, 2, 3, 4, 5]) {
        const pages = await api.pages<ListBody>(`/v2/ledgers/${H}/validations`, limit, 'validations');
        expect([limit, pages.flatMap((p) => p.validations)]).toEqual([limit, unpaged.validations]);
        expect(pages.every((p) => p.count <= limit && p.ledger_hash === H && p.result === 'success')).toBe(true);
        expect(pages[pages.length - 1].marker).toBeUndefined();
      }
    });

    it('the marker is the key of the last validator of the page; the next page starts after it', async () => {
      const first = await get(`/v2/ledgers/${H}/validations?limit=2`);
      expect(first.body.validations.map((v: { validation_public_key: string }) => v.validation_public_key)).toEqual([
        K1,
        K2,
      ]);
      expect(first.body.marker).toBe(markerOf(K2));
      const next = await get(`/v2/ledgers/${H}/validations?limit=2&marker=${first.body.marker}`);
      expect(next.body.validations.map((v: { validation_public_key: string }) => v.validation_public_key)).toEqual([
        K3,
        K4,
      ]);
      expect(next.body.marker).toBeUndefined();
    });

    it('has a marker only when there is more: a page that ends the list has none, and no Link', async () => {
      const exact = await get(`/v2/ledgers/${H}/validations?limit=4`);
      expect([exact.body.count, exact.body.marker, exact.headers.link]).toEqual([4, undefined, undefined]);
      const more = await get(`/v2/ledgers/${H}/validations?limit=3`);
      expect(more.body.marker).toBe(markerOf(K3));
      expect(more.headers.link).toBeDefined();
    });

    it('a marker past the end is an empty page; one before the start is the whole list', async () => {
      expect((await get(`/v2/ledgers/${H}/validations?marker=${markerOf(K4)}`)).body.count).toBe(0);
      expect((await get(`/v2/ledgers/${H}/validations?marker=${markerOf('a')}`)).body.count).toBe(4);
      expect((await get(`/v2/ledgers/${H}/validations?marker=${markerOf('zzz')}`)).body.count).toBe(0);
    });

    it('answers 400 invalid marker for anything that is not a marker of this list', async () => {
      const markers = [
        '!!!',
        Buffer.from('nope').toString('base64url'),
        Buffer.from(JSON.stringify([1])).toString('base64url'),
        Buffer.from(JSON.stringify([K1, K2])).toString('base64url'),
        Buffer.from(JSON.stringify({ key: K1 })).toString('base64url'),
      ];
      for (const marker of markers) {
        const res = await get(`/v2/ledgers/${H}/validations?marker=${marker}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
      // an empty marker is none
      expect((await get(`/v2/ledgers/${H}/validations?marker=`)).body.count).toBe(4);
    });

    it('descending is not a parameter of this route: it is ignored, the order is by validator key', async () => {
      const res = await get(`/v2/ledgers/${H}/validations?descending=true`);
      expect((res.body as ListBody).validations.map((v) => v.validation_public_key)).toEqual(KEYS);
    });
  });

  describe('a ledger with more validators than a page', () => {
    // 1200 validators: more than the largest page. They are rows of their own ledger, so the mock ledger is untouched.
    const BIG = 'CD'.repeat(32);

    beforeAll(async () => {
      await h.ch.command(
        `INSERT INTO ${Table.Validations}
           (ledger_hash, validation_public_key, count, first_datetime, last_datetime, ledger_index, reporter_public_key,
            ephemeral_public_key, signature, signing_time, flags, full, amendments, base_fee, load_fee, reserve_base, reserve_inc)
         SELECT {hash:String}, concat('nH', lpad(toString(number), 6, '0')), 1,
                toDateTime64(toStartOfDay(subtractDays(now('UTC'), 1)), 3, 'UTC'), toDateTime64(toStartOfDay(subtractDays(now('UTC'), 1)), 3, 'UTC'),
                100, 'n9Reporter', 'n9Ephemeral', 'AA', 1, 1, 1, '', NULL, NULL, NULL, NULL
           FROM numbers(1200)`,
        { hash: BIG },
      );
    });

    it('serves 200 by default', async () => {
      const res = await get(`/v2/ledgers/${BIG}/validations`);
      expect(res.body.count).toBe(200);
      expect(res.body.marker).toBe(markerOf('nH000199'));
    });

    it('serves 1000 at most, whatever the limit asked for', async () => {
      for (const limit of [1000, 1001, 5000, 1e9]) {
        const res = await get(`/v2/ledgers/${BIG}/validations?limit=${limit}`);
        expect([limit, res.body.count]).toEqual([limit, 1000]);
      }
      const next = await get(`/v2/ledgers/${BIG}/validations?limit=5000&marker=${markerOf('nH000999')}`);
      expect(next.body.count).toBe(200);
      expect(next.body.marker).toBeUndefined();
    });

    it('pages through all 1200 in order, without a repeat or a gap', async () => {
      const pages = await api.pages<ListBody>(`/v2/ledgers/${BIG}/validations`, 500, 'validations');
      expect(pages.map((p) => p.count)).toEqual([500, 500, 200]);
      const keys = pages.flatMap((p) => p.validations.map((v) => v.validation_public_key));
      expect(keys).toHaveLength(1200);
      expect(keys).toEqual([...keys].sort());
      expect(new Set(keys).size).toBe(1200);
    });
  });

  describe('the singular alias /v2/ledger/:ledger_hash/validations', () => {
    it('singular alias works: the same list, the same pages, the same CSV', async () => {
      const plural = await get(`/v2/ledgers/${H}/validations`);
      const singular = await get(`/v2/ledger/${H}/validations`);
      expect(singular.status).toBe(200);
      expect(singular.body).toEqual(plural.body);

      const page = await get(`/v2/ledger/${H}/validations?limit=2`);
      expect(page.body.marker).toBe(markerOf(K2));
      expect(page.headers.link).toBe(
        `<${new URL(page.request.url).origin}/v2/ledger/${H}/validations?limit=2&marker=${markerOf(K2)}>; rel="next"`,
      );

      const csv = await get(`/v2/ledger/${H}/validations?format=csv`);
      expect(csv.headers['content-disposition']).toBe(`attachment; filename=${H} - validations.csv`);
      expect(csv.text).toBe((await get(`/v2/ledgers/${H}/validations?format=csv`)).text);
    });

    it('the single validation and the errors work on the alias too', async () => {
      const plural = await get(`/v2/ledgers/${H}/validations/${K3}`);
      const singular = await get(`/v2/ledger/${H}/validations/${K3}`);
      expect(singular.status).toBe(200);
      expect(singular.body).toEqual(plural.body);
      expect((await get(`/v2/ledger/zzz/validations`)).body).toEqual({
        result: 'error',
        message: 'invalid ledger hash',
      });
      const missing = await get(`/v2/ledger/${H}/validations/abcd`);
      expect([missing.status, missing.body]).toEqual([404, { result: 'error', message: 'validation not found' }]);
    });

    it('is only the alias: /v2/ledger/:hash and /v2/ledgers/:hash/validations/x/y are not routes', async () => {
      expect((await get(`/v2/ledger/${H}`)).status).toBe(404);
      expect((await get(`/v2/ledgers/${H}/validations/${K1}/more`)).status).toBe(404);
    });
  });

  describe('GET /v2/ledgers/:ledger_hash/validations/:pubkey', () => {
    it('is the flat validation plus result, with result after the columns', async () => {
      const res = await get(`/v2/ledgers/${H}/validations/${K2}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...EXPECTED[1], result: 'success' });
      expect(Object.keys(res.body)).toEqual([...MOCK_KEYS, 'result']);
    });

    it('serves count as a number', async () => {
      const res = await get(`/v2/ledgers/${H}/validations/${K2}`);
      expect(res.body.count).toBe(115);
      expect(typeof res.body.count).toBe('number');
    });

    it('is every validator of the list', async () => {
      for (const [i, key] of KEYS.entries()) {
        const res = await get(`/v2/ledgers/${H}/validations/${key}`);
        expect([key, res.body]).toEqual([key, { ...EXPECTED[i], result: 'success' }]);
      }
    });

    it('is JSON whatever the format (the original ignored it here)', async () => {
      const res = await get(`/v2/ledgers/${H}/validations/${K1}?format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.body.validation_public_key).toBe(K1);
    });

    it('ignores unknown parameters, limit and marker', async () => {
      const plain = (await get(`/v2/ledgers/${H}/validations/${K1}`)).body;
      const res = await get(`/v2/ledgers/${H}/validations/${K1}?limit=0&marker=!!!&foo=bar`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain);
    });

    it('matches the validator key exactly: a prefix or another case is 404 validation not found', async () => {
      for (const key of [K1.slice(0, 10), K1.toLowerCase(), `${K1}x`, 'abcd', 'nHU%']) {
        const res = await get(`/v2/ledgers/${H}/validations/${encodeURIComponent(key)}`);
        expect([key, res.status, res.body]).toEqual([key, 404, { result: 'error', message: 'validation not found' }]);
      }
    });

    it('is 404 for a ledger without validations, and for a validator that did not validate that ledger', async () => {
      const other = await get(`/v2/ledgers/${'AB'.repeat(32)}/validations/${K1}`);
      expect([other.status, other.body.message]).toEqual([404, 'validation not found']);
    });
  });

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('is text/csv, named after the (upper-cased) ledger hash, one row per validator', async () => {
      const res = await get(`/v2/ledgers/${H.toLowerCase()}/validations?format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(`attachment; filename=${H} - validations.csv`);
      expect(lines(res.text)).toHaveLength(1 + 4);
    });

    it('R73: the header is the columns in the order of the first appearance, the first validator first', async () => {
      const res = await get(`/v2/ledgers/${H}/validations?format=csv`);
      const [header, first, second] = lines(res.text);
      // the first validator has no ephemeral key, so that column comes in with the second row: nice-json2csv takes the
      // columns in the order they are first seen
      expect(header.split(',')).toEqual(
        [...MOCK_KEYS.filter((k) => k !== 'ephemeral_public_key'), 'ephemeral_public_key'].map((k) => `"${k}"`),
      );
      expect(first.split(',').slice(0, 3)).toEqual(['"13"', `"${YESTERDAY}T16:45:20.466Z"`, '"2147483649"']);
      expect(first.split(',')).toHaveLength(12);
      expect(second.split(',')[0]).toBe('"115"');
      expect(second.endsWith('"n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy"')).toBe(true);
    });

    it('is the same rows as the JSON, with the Link header when there is a next page', async () => {
      const csv = await get(`/v2/ledgers/${H}/validations?format=csv&limit=2`);
      expect(lines(csv.text)).toHaveLength(1 + 2);
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/ledgers/${H}/validations?format=csv&limit=2&marker=${markerOf(K2)}>; rel="next"`,
      );
      expect((await get(`/v2/ledgers/${H}/validations?format=csv&limit=4`)).headers.link).toBeUndefined();
    });

    it('is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get(`/v2/ledgers/${H}/validations?format=CSV`)).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`/v2/ledgers/${H}/validations?format=${format}`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('an empty ledger is an empty CSV; an error is still JSON', async () => {
      const empty = await get(`/v2/ledgers/${'AB'.repeat(32)}/validations?format=csv`);
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get(`/v2/ledgers/zzz/validations?format=csv`);
      expect(bad.status).toBe(400);
      expect(bad.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('the query', () => {
    const validationsSql = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(([q]) => new RegExp(`FROM ${Table.Validations}\\b`).test(String(q)))
        .map(([q, p]) => [String(q), p as Record<string, unknown>]);

    it('binds the hash, the cursor and the page size, groups by the whole key and never uses FINAL', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`/v2/ledgers/${H.toLowerCase()}/validations?limit=2&marker=${markerOf(K1)}`);
      const [[sql, params]] = validationsSql(spy);
      expect(sql).toMatch(/WHERE ledger_hash = \{hash:String\} AND \(validation_public_key\) > \(\{k0:String\}\)/);
      expect(sql).toMatch(
        /GROUP BY ledger_hash, validation_public_key\s+ORDER BY validation_public_key ASC\s+LIMIT \{fetch:UInt32\}/,
      );
      expect(sql).toMatch(/sum\(count\)/);
      expect(sql).toMatch(/min\(first_datetime\)/);
      expect(sql).toMatch(/max\(last_datetime\)/);
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(params).toEqual({ hash: H, k0: K1, fetch: 3 });
      // nothing the client sent is in the text of the query
      expect(sql).not.toContain(H);
      expect(sql).not.toContain(K1);
    });

    it('binds the validator key of the single route too', async () => {
      const spy = jest.spyOn(h.ch, 'queryOne');
      await get(`/v2/ledgers/${H}/validations/${encodeURIComponent("x' OR 1=1 --")}`);
      const [sql, params] = spy.mock.calls[0] as [string, Record<string, unknown>];
      expect(sql).toMatch(/WHERE ledger_hash = \{hash:String\} AND validation_public_key = \{pubkey:String\}/);
      expect(sql).toMatch(/GROUP BY ledger_hash, validation_public_key\s+LIMIT 1/);
      expect(params).toEqual({ hash: H, pubkey: "x' OR 1=1 --" });
    });

    it('is a failure of the route when ClickHouse fails: 500 unable to retrieve ledger, for both routes', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('Code: 241. Memory limit exceeded'));
      const list = await get(`/v2/ledgers/${H}/validations`);
      expect([list.status, list.body]).toEqual([500, { result: 'error', message: 'unable to retrieve ledger' }]);

      jest.spyOn(h.ch, 'queryOne').mockRejectedValueOnce(new Error('Code: 241. Memory limit exceeded'));
      const one = await get(`/v2/ledgers/${H}/validations/${K1}`);
      expect([one.status, one.body]).toEqual([500, { result: 'error', message: 'unable to retrieve ledger' }]);
    });
  });
});

// ===================================================================================================================
// partial rows
// ===================================================================================================================

describe('GET /v2/ledgers/:ledger_hash/validations when a validation is several rows', () => {
  // `validations` is an AggregatingMergeTree that the syncer writes in pieces (a flush every 20 s, sightings that fall into
  // two days), and the lists never use FINAL, so until a merge a validation is several rows. Merges are stopped and a
  // SECOND insert (rows inside one insert are collapsed on the way in) puts the second piece next to the first.
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  const t = (iso: string): number => Date.parse(iso) / 1000;
  const count = async (): Promise<number> =>
    Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.Validations}`))[0].n);

  const A = 'AA'.repeat(32);
  const B = 'BB'.repeat(32);

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.Validations}`);
    // first piece: K1 and K2 of ledger A, seen by node 1 between 12:00:00.100 and 12:00:00.400
    await h.ch.insert(Table.Validations, [
      row({
        ledger_hash: A,
        validation_public_key: K1,
        count: 3,
        first_datetime: t(`${YESTERDAY}T12:00:00.100Z`),
        last_datetime: t(`${YESTERDAY}T12:00:00.400Z`),
        reporter_public_key: 'n9Node1',
        base_fee: '10',
        amendments: '["AB"]',
      }),
      row({
        ledger_hash: A,
        validation_public_key: K2,
        count: 1,
        first_datetime: t(`${YESTERDAY}T12:00:00.200Z`),
        last_datetime: t(`${YESTERDAY}T12:00:00.200Z`),
        reporter_public_key: 'n9Node1',
      }),
    ]);
    // second piece: K1 again (node 2, a later flush: it adds to the count and moves the last time), and K3
    await h.ch.insert(
      Table.Validations,
      [
        row({
          ledger_hash: A,
          validation_public_key: K1,
          count: 2,
          first_datetime: t(`${YESTERDAY}T12:00:20.050Z`),
          last_datetime: t(`${YESTERDAY}T12:00:20.900Z`),
          reporter_public_key: 'n9Node2',
          base_fee: '99',
        }),
        row({
          ledger_hash: A,
          validation_public_key: K3,
          count: 4,
          first_datetime: t(`${YESTERDAY}T12:00:20.000Z`),
          last_datetime: t(`${YESTERDAY}T12:00:20.000Z`),
        }),
      ],
      {},
    );
    // a third piece, EARLIER than the first (a node that was slow to flush): it moves the first time back
    await h.ch.insert(Table.Validations, [
      row({
        ledger_hash: A,
        validation_public_key: K1,
        count: 1,
        first_datetime: t(`${YESTERDAY}T12:00:00.001Z`),
        last_datetime: t(`${YESTERDAY}T12:00:00.001Z`),
        reporter_public_key: 'n9Node3',
        base_fee: '7',
      }),
    ]);
    expect(await count()).toBe(5); // five rows for four (hash, validator) pairs: K1 of ledger A is three of them
  });
  afterAll(async () => {
    await h?.close();
  });

  it('really is several rows until a merge', async () => {
    const parts = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM system.parts WHERE database = {db:String} AND table = {t:String} AND active`,
      { db: h.database, t: Table.Validations },
    );
    expect(Number(parts[0].n)).toBeGreaterThanOrEqual(3);
    const raw = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.Validations} WHERE ledger_hash = {a:String} AND validation_public_key = {k:String}`,
      { a: A, k: K1 },
    );
    expect(Number(raw[0].n)).toBe(3); // K1 of ledger A: three rows
  });

  it('reads the pieces as one validation: summed count, earliest first_datetime, latest last_datetime', async () => {
    const res = await get(`/v2/ledgers/${A}/validations/${K1}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      count: 6, // 3 + 2 + 1
      first_datetime: `${YESTERDAY}T12:00:00.001Z`,
      last_datetime: `${YESTERDAY}T12:00:20.900Z`,
      validation_public_key: K1,
    });
  });

  it('takes the other fields of the EARLIEST piece, the same on every read', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await get(`/v2/ledgers/${A}/validations/${K1}`);
      expect(res.body).toMatchObject({ reporter_public_key: 'n9Node3', base_fee: '7' });
      expect(res.body).not.toHaveProperty('amendments'); // the piece of node 1 had them; the earliest piece has none
    }
  });

  it('lists every validator once, with its pieces added up, in order', async () => {
    const res = await get(`/v2/ledgers/${A}/validations`);
    expect(res.body.count).toBe(3);
    expect((res.body as ListBody).validations.map((v) => [v.validation_public_key, v.count])).toEqual([
      [K1, 6],
      [K2, 1],
      [K3, 4],
    ]);
  });

  it('pages cut anywhere neither repeat nor skip a validator', async () => {
    const unpaged = (await get(`/v2/ledgers/${A}/validations`)).body as ListBody;
    for (const limit of [1, 2, 3]) {
      const pages = await api.pages<ListBody>(`/v2/ledgers/${A}/validations`, limit, 'validations');
      expect([limit, pages.flatMap((p) => p.validations)]).toEqual([limit, unpaged.validations]);
    }
  });

  it('keeps the ledgers apart: a validator of another ledger is not added in', async () => {
    await h.ch.insert(Table.Validations, [row({ ledger_hash: B, validation_public_key: K1, count: 40 })]);
    expect((await get(`/v2/ledgers/${A}/validations/${K1}`)).body.count).toBe(6);
    expect((await get(`/v2/ledgers/${B}/validations/${K1}`)).body.count).toBe(40);
  });

  it('adds the pieces of the same validation that fall into different days', async () => {
    const C = 'CC'.repeat(32);
    await h.ch.insert(Table.Validations, [
      row({
        ledger_hash: C,
        count: 5,
        first_datetime: t(`${DAY_BEFORE}T23:59:59.900Z`),
        last_datetime: t(`${DAY_BEFORE}T23:59:59.950Z`),
      }),
    ]);
    await h.ch.insert(Table.Validations, [
      row({
        ledger_hash: C,
        count: 6,
        first_datetime: t(`${YESTERDAY}T00:00:00.100Z`),
        last_datetime: t(`${YESTERDAY}T00:00:00.300Z`),
      }),
    ]);
    const partitions = await h.ch.query<{ p: string }>(
      `SELECT DISTINCT _partition_id AS p FROM ${Table.Validations} WHERE ledger_hash = {c:String} ORDER BY p`,
      { c: C },
    );
    expect(partitions.map((r) => r.p)).toEqual([DAY_BEFORE.replaceAll('-', ''), YESTERDAY.replaceAll('-', '')]);
    const res = await get(`/v2/ledgers/${C}/validations/${K1}`);
    expect(res.body).toMatchObject({
      count: 11,
      first_datetime: `${DAY_BEFORE}T23:59:59.900Z`,
      last_datetime: `${YESTERDAY}T00:00:00.300Z`,
    });
  });

  it('a second copy of every row of a ledger (a real duplicate) adds the counts, and moves nothing else', async () => {
    const before = await count();
    const unpaged = (await get(`/v2/ledgers/${A}/validations`)).body as ListBody;
    // a SECOND insert with deduplication off: the rows of ledger A are now in the table twice (merges are stopped)
    await h.ch.command(
      `INSERT INTO ${Table.Validations} SELECT * FROM ${Table.Validations} WHERE ledger_hash = {a:String}`,
      { a: A },
      { settings: { insert_deduplicate: 0, optimize_on_insert: 0 } },
    );
    expect(await count()).toBe(before + 5);

    const doubled = (await get(`/v2/ledgers/${A}/validations`)).body as ListBody;
    expect(doubled.validations.map((v) => [v.validation_public_key, v.count])).toEqual([
      [K1, 12],
      [K2, 2],
      [K3, 8],
    ]);
    // everything but the counts is what it was: the times, the fields of the earliest piece, the order
    expect(doubled.validations.map(({ count: _count, ...rest }) => rest)).toEqual(
      unpaged.validations.map(({ count: _count, ...rest }) => rest),
    );
    for (const limit of [1, 2]) {
      const pages = await api.pages<ListBody>(`/v2/ledgers/${A}/validations`, limit, 'validations');
      expect([limit, pages.flatMap((p) => p.validations)]).toEqual([limit, doubled.validations]);
    }
    expect((await get(`/v2/ledgers/${A}/validations/${K1}`)).body).toMatchObject({
      count: 12,
      first_datetime: `${YESTERDAY}T12:00:00.001Z`,
      last_datetime: `${YESTERDAY}T12:00:20.900Z`,
    });
  });
});

// ===================================================================================================================
// the plan
// ===================================================================================================================

describe('GET /v2/ledgers/:ledger_hash/validations: the plan of the query', () => {
  // 100 000 validations of 100 000 ledgers (13 granules) and a ledger of 50 validators: the lookup must read the
  // granules of its ledger, not the table.
  let h: Harness;
  let get: ApiClient['get'];
  const LEDGER = 'EF'.repeat(32);

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
    await h.ch.command(
      `INSERT INTO ${Table.Validations}
         (ledger_hash, validation_public_key, count, first_datetime, last_datetime, ledger_index, reporter_public_key,
          ephemeral_public_key, signature, signing_time, flags, full, amendments, base_fee, load_fee, reserve_base, reserve_inc)
       SELECT lpad(upper(hex(sipHash64(number))), 64, '0'), 'nH000001', 1,
              toDateTime64(toStartOfDay(subtractDays(now('UTC'), 1)), 3, 'UTC'), toDateTime64(toStartOfDay(subtractDays(now('UTC'), 1)), 3, 'UTC'),
              100, 'n9Reporter', 'n9Ephemeral', 'AA', 1, 1, 1, '', NULL, NULL, NULL, NULL
         FROM numbers(100000)`,
    );
    await h.ch.command(
      `INSERT INTO ${Table.Validations}
         (ledger_hash, validation_public_key, count, first_datetime, last_datetime, ledger_index, reporter_public_key,
          ephemeral_public_key, signature, signing_time, flags, full, amendments, base_fee, load_fee, reserve_base, reserve_inc)
       SELECT {hash:String}, concat('nH', lpad(toString(number), 6, '0')), 1,
              toDateTime64(toStartOfDay(subtractDays(now('UTC'), 1)), 3, 'UTC'), toDateTime64(toStartOfDay(subtractDays(now('UTC'), 1)), 3, 'UTC'),
              100, 'n9Reporter', 'n9Ephemeral', 'AA', 1, 1, 1, '', NULL, NULL, NULL, NULL
         FROM numbers(50)`,
      { hash: LEDGER },
    );
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const sqlOf = (spy: jest.SpyInstance): [string, Record<string, unknown>] => {
    const calls = spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Validations}\\b`).test(String(q)));
    expect(calls).toHaveLength(1);
    return [String(calls[0][0]), calls[0][1] as Record<string, unknown>];
  };
  const indexesOf = async (sql: string, params: Record<string, unknown>): Promise<string> =>
    (await h.ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params)).map((r) => r.explain).join('\n');

  /** `PrimaryKey ... Granules: a/b` of an EXPLAIN. */
  const primaryKey = (plan: string): { keys: string; selected: number; total: number } => {
    const section =
      /PrimaryKey\s*\n\s*Keys:\s*\n((?:\s+\S+\n)+?)\s*Condition:[^\n]*\n\s*Parts: \d+\/\d+\n\s*Granules: (\d+)\/(\d+)/.exec(
        plan,
      );
    if (!section) throw new Error(`no PrimaryKey section in:\n${plan}`);
    return {
      keys: section[1]
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(','),
      selected: Number(section[2]),
      total: Number(section[3]),
    };
  };

  it('the data is there: 100 000 ledgers of one validator, and one of 50', async () => {
    const res = await get(`/v2/ledgers/${LEDGER}/validations?limit=1000`);
    expect(res.body.count).toBe(50);
  });

  it('the list filters ledger_hash through the primary key and reads a granule or two of the table', async () => {
    const spy = jest.spyOn(h.ch, 'query');
    await get(`/v2/ledgers/${LEDGER}/validations`);
    const [sql, params] = sqlOf(spy);
    jest.restoreAllMocks();
    const pk = primaryKey(await indexesOf(sql, params));
    expect(pk.keys).toBe('ledger_hash');
    expect(pk.total).toBeGreaterThanOrEqual(10);
    expect(pk.selected).toBeLessThanOrEqual(2);
  });

  it('a page after a marker narrows it on the next column of the key', async () => {
    const spy = jest.spyOn(h.ch, 'query');
    await get(`/v2/ledgers/${LEDGER}/validations?limit=5&marker=${markerOf('nH000010')}`);
    const [sql, params] = sqlOf(spy);
    jest.restoreAllMocks();
    const pk = primaryKey(await indexesOf(sql, params));
    expect(pk.keys).toBe('ledger_hash,validation_public_key');
    expect(pk.selected).toBeLessThanOrEqual(2);
  });

  it('the single validation uses the whole key', async () => {
    const spy = jest.spyOn(h.ch, 'queryOne');
    await get(`/v2/ledgers/${LEDGER}/validations/nH000007`);
    const [sql, params] = sqlOf(spy);
    jest.restoreAllMocks();
    const pk = primaryKey(await indexesOf(sql, params));
    expect(pk.keys).toBe('ledger_hash,validation_public_key');
    expect(pk.selected).toBeLessThanOrEqual(2);
  });
});

// ===================================================================================================================
// Xahau
// ===================================================================================================================

describe('GET /v2/ledgers/:ledger_hash/validations on Xahau', () => {
  let h: Harness;
  let get: ApiClient['get'];
  const XAHAU_HASH = '5A3DE0C5B7A8E8C86A1B0C7E4A5C9AAF3E2D9F1B7C6A5D4E3F2A1B0C9D8E7F60';
  const V1 = 'nHBXahauValidatorOneeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const V2 = 'nHBXahauValidatorTwooooooooooooooooooooooooooooooooooo';

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', seed: 'none', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
    await h.ch.insert(Table.Validations, [
      row({
        ledger_hash: XAHAU_HASH,
        validation_public_key: V2,
        count: 9,
        base_fee: '10',
        reserve_base: '1000000',
        reserve_inc: '200000',
      }),
      row({ ledger_hash: XAHAU_HASH, validation_public_key: V1, count: 4, full: 0 }),
    ]);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('serves the same shapes: list, pages, single validation, alias, CSV', async () => {
    const list = await get(`/v2/ledgers/${XAHAU_HASH}/validations`);
    expect(list.status).toBe(200);
    expect(list.body.ledger_hash).toBe(XAHAU_HASH);
    expect((list.body as ListBody).validations.map((v) => [v.validation_public_key, v.count])).toEqual([
      [V1, 4],
      [V2, 9],
    ]);

    const [partial, full] = (list.body as ListBody).validations;
    expect(Object.keys(partial)).toEqual([
      'count',
      'ephemeral_public_key',
      'first_datetime',
      'flags',
      'last_datetime', // a partial validation has no `full`
      'ledger_hash',
      'ledger_index',
      'reporter_public_key',
      'signature',
      'signing_time',
      'validation_public_key',
    ]);
    expect(Object.keys(full)).toEqual([
      'base_fee',
      'count',
      'ephemeral_public_key',
      'first_datetime',
      'flags',
      'full',
      'last_datetime',
      'ledger_hash',
      'ledger_index',
      'reporter_public_key',
      'reserve_base',
      'reserve_inc',
      'signature',
      'signing_time',
      'validation_public_key',
    ]);
    expect(full).toMatchObject({ base_fee: '10', reserve_base: '1000000', reserve_inc: '200000', full: 'true' });

    expect((await get(`/v2/ledgers/${XAHAU_HASH}/validations?limit=1`)).body.marker).toBe(markerOf(V1));
    expect((await get(`/v2/ledger/${XAHAU_HASH}/validations/${V2}`)).body).toEqual({ ...full, result: 'success' });
    expect((await get(`/v2/ledgers/${XAHAU_HASH}/validations?format=csv`)).headers['content-disposition']).toBe(
      `attachment; filename=${XAHAU_HASH} - validations.csv`,
    );
    expect((await get(`/v2/ledgers/${'AB'.repeat(32)}/validations/${V1}`)).status).toBe(404);
  });
});

// ===================================================================================================================
// the app around it
// ===================================================================================================================

describe('validations routes in the app', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('need the API key, like every /v2 route', async () => {
    const res = await h.http().get(`/v2/ledgers/${H}/validations`);
    expect(res.status).toBe(401);
    const ok = await h.http().get(`/v2/ledgers/${H}/validations`).set('X-API-Key', h.key);
    expect(ok.status).toBe(200);
    const bearer = await h.http().get(`/v2/ledger/${H}/validations/${K1}`).set('Authorization', `Bearer ${h.key}`);
    expect(bearer.status).toBe(404);
    expect(bearer.body.message).toBe('validation not found');
  });

  it('the ledger route still answers /v2/ledgers/:hash, next to /validations', async () => {
    const res = await h.http().get(`/v2/ledgers/${H}`).set('X-API-Key', h.key);
    expect(res.status).toBe(404); // no ledgers in this database
    expect(res.body.message).toBe('ledger not found');
  });

  it('is in the swagger document under both paths', async () => {
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(h.app, new DocumentBuilder().setTitle('t').build());
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v2/ledgers/{ledger_hash}/validations',
        '/v2/ledgers/{ledger_hash}/validations/{pubkey}',
        '/v2/ledger/{ledger_hash}/validations',
        '/v2/ledger/{ledger_hash}/validations/{pubkey}',
      ]),
    );
  });
});
