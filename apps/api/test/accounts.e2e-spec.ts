import { AccountsCreatedRow, Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { FixtureAccount, fixtureAccountsCreated } from './support/fixtures';

/**
 * `GET /v2/accounts` and `GET /v2/accounts/:address` on a real ClickHouse, seeded with the 54 ledgers of the original
 * Ripple test suite (`ripple-mock`: 13 accounts created, 9 of them in ledger 1021029 by rJR7gjNe…, 3 by rMTzGg7n…, 1 by
 * rUeXUxaM…) and, for the Xahau case, with the recorded Xahau ledgers (which create no account) plus synthetic rows.
 *
 * Ported from rippled-historical-database `test/test.accounts.js` (all 12 `it`s, same titles, none skipped). Four of
 * them are ported to what this API holds instead of what HBase did:
 *  - 'should make sure accounts handles pagination correctly' walks the list one account at a time with `limit=1` and
 *    compares each page with the unpaged list, as the original does (it compared `base_amount`, a field accounts do not
 *    have, so it is `account` here); only the marker is this API's;
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`20130611200120|000001021029|00001`); the marker of this API is `(ledger_index, tx_index, account)` of the last
 *    row of the page;
 *  - 'should get reduced accounts created' and '... by parent' send `reduce=true`, which `accounts.js` never reads
 *    (only `getReducedAccounts` of the HBase layer does, and the route does not pass `reduce` on), so they are plain
 *    lists with an ignored parameter, as on data.ripple.com.
 *
 * Added: the account object (fields, key order, genesis_* left out while null), the envelope, the lookup (the latest
 * creation of an address, 404 for anything that has none, hostile text), the `parent` filter, the order of the checks,
 * ordering, marker pages (also inside a transaction that created two accounts), limits, CSV, rows written twice, the
 * tables and the plan of the queries, the failure path, and Xahau.
 */

const byKey = (a: FixtureAccount, b: FixtureAccount): number =>
  a.row.ledger_index - b.row.ledger_index ||
  a.row.tx_index - b.row.tx_index ||
  (a.row.account < b.row.account ? -1 : a.row.account > b.row.account ? 1 : 0);
/** Every mock account in the order of the list, ascending. */
const ALL = [...fixtureAccountsCreated('ripple-mock')].sort(byKey);

const FIRST = 'rHTaDFHJng6YVtThvv522LmJfkocBVkK6Z';
const PARENT_3 = 'rMTzGg7nPPEMJthjgEBfiPZGoAM7MEVa1r';
const PARENT_9 = 'rJR7gjNe3DpJ7kpB4CHBxjDKfwVMpTKPpj';
const PARENT_1 = 'rUeXUxaMTH1pELvD2EkiHTRcM9FsH3v4d7';

/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;
/** The accounts created in `[from, before)`. */
const createdBetween = (from: string, before: string): FixtureAccount[] =>
  ALL.filter((a) => a.row.inception >= unix(from) && a.row.inception < unix(before));
/** `YYYY-MM-DDTHH:mm:ssZ` of unix seconds. */
const inceptionOf = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
/** The marker of a row: `(ledger_index, tx_index, account)` as base64url JSON. */
const markerOf = (row: Pick<AccountsCreatedRow, 'ledger_index' | 'tx_index' | 'account'>): string =>
  Buffer.from(JSON.stringify([row.ledger_index, row.tx_index, row.account]), 'utf8').toString('base64url');

/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

/**
 * The account of a stored row, written out the way the original served it (`accounts.js`): account, parent,
 * initial_balance, inception, ledger_index, tx_hash, and the genesis fields only when the row has them.
 */
function accountOf(row: AccountsCreatedRow): Record<string, unknown> {
  return {
    account: row.account,
    parent: row.parent,
    initial_balance: row.initial_balance,
    inception: inceptionOf(row.inception),
    ledger_index: row.ledger_index,
    tx_hash: row.tx_hash,
    ...(row.genesis_balance !== null && { genesis_balance: row.genesis_balance }),
    ...(row.genesis_index !== null && { genesis_index: row.genesis_index }),
  };
}
const accountsOf = (accounts: { row: AccountsCreatedRow }[]): Record<string, unknown>[] =>
  accounts.map((a) => accountOf(a.row));

interface ListBody {
  result: string;
  count: number;
  marker?: string;
  accounts: Record<string, unknown>[];
}
const namesIn = (body: ListBody): unknown[] => body.accounts.map((a) => a.account);
const namesOf = (accounts: { row: AccountsCreatedRow }[]): string[] => accounts.map((a) => a.row.account);

describe('accounts API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'accounts');
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  // -- test.accounts.js -----------------------------------------------------------------------------------------

  it('should get individual accounts created', async () => {
    let last = 0;
    const res = await get('/v2/accounts');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.accounts.length).toBe(res.body.count);
    expect(res.body.accounts.length).toBe(13);
    for (const a of (res.body as ListBody).accounts) {
      expect(typeof a.ledger_index).toBe('number');
      expect(typeof a.initial_balance).toBe('string');
      expect(typeof a.inception).toBe('string');
      expect(typeof a.account).toBe('string');
      expect(typeof a.parent).toBe('string');
      expect(typeof a.tx_hash).toBe('string');
      expect(last <= (a.ledger_index as number)).toBe(true);
      last = a.ledger_index as number;
    }
    expect(res.body.accounts[0].account).toBe(FIRST);
  });

  it('should get individual accounts created by date', async () => {
    const start = '2013-01-14T18:28:40Z';
    const end = '2013-07-01T00:00:00Z';
    const res = await get(`/v2/accounts${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.accounts.length).toBe(res.body.count);
    expect(res.body.accounts.length).toBe(9);
    for (const a of (res.body as ListBody).accounts) {
      const time = Date.parse(a.inception as string);
      expect(Date.parse(start) - time).toBeLessThanOrEqual(0); // inception less than start time
      expect(Date.parse(end) - time).toBeGreaterThanOrEqual(0); // inception greater than end time
    }
    // and they are the accounts created in the window
    expect(namesIn(res.body)).toEqual(namesOf(createdBetween('2013-01-14T18:28:40', '2013-07-01T00:00:01')));
  });

  it('get individual accounts created in descending order', async () => {
    let last = Infinity;
    const res = await get('/v2/accounts?descending=true');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.accounts.length).toBe(res.body.count);
    expect(res.body.accounts.length).toBe(13);
    for (const a of (res.body as ListBody).accounts) {
      expect(last >= (a.ledger_index as number)).toBe(true);
      last = a.ledger_index as number;
    }
  });

  it('should get individual accounts created by parent', async () => {
    const res = await get(`/v2/accounts${qs({ parent: PARENT_3 })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.accounts.length).toBe(res.body.count);
    expect(res.body.accounts.length).toBe(3);
    for (const a of (res.body as ListBody).accounts) expect(a.parent).toBe(PARENT_3);
  });

  it('should make sure accounts handles pagination correctly', async () => {
    const url = '/v2/accounts?';
    const ref = await get(url);
    expect(ref.status).toBe(200);
    expect(ref.body.result).toBe('success');
    expect(ref.body.count).toBeGreaterThan(1); // must be at least 2

    let marker: string | undefined;
    for (let i = 0; i < ref.body.count; i++) {
      const res = await get(`${url}&limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.accounts).toHaveLength(1);
      expect(res.body.accounts[0].account).toBe(ref.body.accounts[i].account);
      expect(res.body.accounts[0].tx_hash).toBe(ref.body.accounts[i].tx_hash);
      marker = res.body.marker;
    }
    expect(marker).toBeUndefined();
  });

  it('should get reduced accounts created', async () => {
    const start = '2013-06-11T00:00:00Z';
    const end = '2013-07-01T00:00:00Z';
    const res = await get(`/v2/accounts${qs({ reduce: true, start, end })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(9);
    // `reduce` is not read by the route: the same list as without it
    expect(res.body).toEqual((await get(`/v2/accounts${qs({ start, end })}`)).body);
  });

  it('should get reduced accounts created by parent', async () => {
    const res = await get(`/v2/accounts${qs({ reduce: true, parent: PARENT_3 })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(3);
    expect(res.body).toEqual((await get(`/v2/accounts${qs({ parent: PARENT_3 })}`)).body);
  });

  it('should get and individual account', async () => {
    const account = 'rGTvj2qFEYunK7vnWeWmxwvTcL2svvVP7b';
    const res = await get(`/v2/accounts/${account}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(typeof res.body.account_data).toBe('object');
    expect(res.body.account_data.account).toBe(account);
    expect(typeof res.body.account_data.parent).toBe('string');
    expect(typeof res.body.account_data.initial_balance).toBe('string');
    expect(typeof res.body.account_data.inception).toBe('string');
    expect(typeof res.body.account_data.tx_hash).toBe('string');
    expect(typeof res.body.account_data.ledger_index).toBe('number');
  });

  it('should return an error if an account is not found', async () => {
    const res = await get('/v2/accounts/zzz');
    expect(res.status).toBe(404);
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('Account not found');
  });

  it('should return an error for an invalid start date', async () => {
    const res = await get('/v2/accounts?start=2015x');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid start date format');
  });

  it('should return an error for an invalid end time', async () => {
    const res = await get('/v2/accounts?end=2015x');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid end date format');
  });

  it('should include a link header when marker is present', async () => {
    const res = await get('/v2/accounts?limit=1');
    expect(res.status).toBe(200);
    // the marker of this API is the key of the last row of the page
    const marker = markerOf(ALL[0].row);
    expect(res.body.marker).toBe(marker);
    const origin = new URL(res.request.url).origin;
    expect(res.headers.link).toBe(`<${origin}/v2/accounts?limit=1&marker=${marker}>; rel="next"`);
  });

  // -- the account ------------------------------------------------------------------------------------------------

  describe('the account object', () => {
    it('every account of the mock ledgers is served, oldest first, as the original formats it', async () => {
      expect(ALL).toHaveLength(13);
      const res = await get('/v2/accounts');
      expect(res.body.accounts).toEqual(accountsOf(ALL));
      // `toEqual` does not look at the order of the keys
      (res.body as ListBody).accounts.forEach((a, i) =>
        expect([i, Object.keys(a)]).toEqual([
          i,
          ['account', 'parent', 'initial_balance', 'inception', 'ledger_index', 'tx_hash'],
        ]),
      );
    });

    it('ledger 1021029 created 9 of them, in the order of its transactions; the first account is rHTaDFHJ…', async () => {
      const res = await get('/v2/accounts');
      expect(res.body.accounts[0]).toEqual({
        account: FIRST,
        parent: PARENT_9,
        initial_balance: '1000',
        inception: '2013-06-11T20:01:20Z',
        ledger_index: 1021029,
        tx_hash: 'E011E6D20BE1FAC7C37F2FA0D36F0811C404B118D936963051600796FF2C0CBC',
      });
      const inLedger = (res.body as ListBody).accounts.filter((a) => a.ledger_index === 1021029);
      expect(inLedger).toHaveLength(9);
      expect(inLedger.every((a) => a.parent === PARENT_9)).toBe(true);
      expect(res.body.accounts.at(-1)).toEqual({
        account: 'rPTFJDMfRnY8RBsvsiYDGp6Gmuguoxg3FB',
        parent: PARENT_1,
        initial_balance: '98',
        inception: '2015-02-09T20:30:00Z',
        ledger_index: 11618225,
        tx_hash: 'A5FB5B659899BCD535C9A635366433C66D6C85055C313C70FE8BD38C1710E398',
      });
    });

    it('the balance is the exact decimal text, the inception is YYYY-MM-DDTHH:mm:ssZ', async () => {
      for (const a of (await get('/v2/accounts')).body.accounts) {
        expect(a.initial_balance).toMatch(/^\d+(\.\d+)?$/);
        expect(a.inception).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      }
    });

    it('genesis_balance and genesis_index are null in the table, so they are left out (not null)', async () => {
      const rows = await h.ch.query<{ gb: string | null; gi: number | null }>(
        `SELECT genesis_balance AS gb, genesis_index AS gi FROM ${Table.AccountsCreated}`,
      );
      expect(rows).toHaveLength(13);
      expect(rows.every((r) => r.gb === null && r.gi === null)).toBe(true);
      const res = await get('/v2/accounts');
      for (const a of res.body.accounts) {
        expect(a).not.toHaveProperty('genesis_balance');
        expect(a).not.toHaveProperty('genesis_index');
      }
      expect(res.text).not.toContain('null');
    });

    it('the response envelope: result, count, marker (when there is one), accounts', async () => {
      expect(Object.keys((await get('/v2/accounts')).body)).toEqual(['result', 'count', 'accounts']);
      expect(Object.keys((await get('/v2/accounts?limit=2')).body)).toEqual(['result', 'count', 'marker', 'accounts']);
    });
  });

  // -- the lookup -------------------------------------------------------------------------------------------------

  describe('GET /v2/accounts/:address', () => {
    it('serves every account of the list, as {result, account_data} with the same fields', async () => {
      for (const a of ALL) {
        const res = await get(`/v2/accounts/${a.row.account}`);
        expect([a.row.account, res.status]).toEqual([a.row.account, 200]);
        expect(Object.keys(res.body)).toEqual(['result', 'account_data']);
        expect(res.body.result).toBe('success');
        expect(res.body.account_data).toEqual(accountOf(a.row));
        expect(Object.keys(res.body.account_data)).toEqual(Object.keys(accountOf(a.row)));
      }
    });

    it('a 404 is {result: error, message: Account not found}, exactly', async () => {
      const res = await get('/v2/accounts/zzz');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ result: 'error', message: 'Account not found' });
    });

    it('an address that never was created is 404: valid, the parent of other accounts, in another case', async () => {
      const cases = [
        'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
        'rHTaDFHJng6YVtThvv522LmJfkocBVkK6', // one character short
        PARENT_9, // exists on the ledger, but was created before the mock ledgers start: no row
        FIRST.toLowerCase(), // the address is compared as it is written
        FIRST.toUpperCase(),
        `${FIRST} `,
        `x${FIRST}`,
      ];
      for (const address of cases) {
        const res = await get(`/v2/accounts/${encodeURIComponent(address)}`);
        expect([address, res.status, res.body]).toEqual([
          address,
          404,
          { result: 'error', message: 'Account not found' },
        ]);
      }
    });

    it('the address is not validated (the original did not), and hostile text is only ever a bound value', async () => {
      const hostile = [
        "x'; DROP TABLE accounts_created; --",
        "' OR '1'='1",
        '%',
        '\\',
        '\\0',
        '{a:String}',
        '${jndi:ldap://x}',
        '\u20ac\u00e9\u4e2d',
        'a\nb',
        'a\tb',
        'a\0b',
        'r'.repeat(5000),
      ];
      for (const address of hostile) {
        const query = jest.spyOn(h.ch, 'query');
        const res = await get(`/v2/accounts/${encodeURIComponent(address)}`);
        expect([address.slice(0, 20), res.status, res.body]).toEqual([
          address.slice(0, 20),
          404,
          { result: 'error', message: 'Account not found' },
        ]);
        // bound as a parameter, never written into the statement
        const lookups = query.mock.calls.filter(([q]) => String(q).includes(Table.AccountsCreated));
        expect(lookups).toHaveLength(1);
        if (address.length > 2) expect(String(lookups[0][0])).not.toContain(address);
        expect(lookups[0][1]).toMatchObject({ account: address });
        jest.restoreAllMocks();
      }
      // and the table is still there
      expect((await get('/v2/accounts')).body.count).toBe(13);
    });

    it('an empty address is not this route', async () => {
      // `/v2/accounts/` is the list
      expect((await get('/v2/accounts/')).body.count).toBe(13);
    });

    it('format=csv and the other list parameters are ignored', async () => {
      const plain = await get(`/v2/accounts/${FIRST}`);
      const res = await get(`/v2/accounts/${FIRST}?format=csv&limit=0&start=x&marker=!&parent=nobody`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual(plain.body);
    });

    it('is the latest creation of the address: ORDER BY ledger_index DESC, tx_index DESC LIMIT 1, by account', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await get(`/v2/accounts/${FIRST}`);
      const sql = query.mock.calls.map(([q]) => String(q)).filter((q) => q.includes(Table.AccountsCreated));
      expect(sql).toHaveLength(1);
      expect(sql[0]).toMatch(/WHERE\s+account = \{account:String\}/);
      expect(sql[0]).toMatch(/ORDER BY ledger_index DESC, tx_index DESC\s+LIMIT 1\b/);
      expect(sql[0]).not.toMatch(/\bFINAL\b/);
      expect(sql[0]).not.toContain(FIRST);
    });

    it('is 500 unable to get accounts when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      const res = await get(`/v2/accounts/${FIRST}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ result: 'error', message: 'unable to get accounts' });
    });
  });

  // -- the parent filter ------------------------------------------------------------------------------------------

  describe('parent', () => {
    it('lists the accounts one address created', async () => {
      for (const [parent, count] of [
        [PARENT_9, 9],
        [PARENT_3, 3],
        [PARENT_1, 1],
      ] as const) {
        const res = await get(`/v2/accounts${qs({ parent })}`);
        expect([parent, res.body.count]).toEqual([parent, count]);
        expect(res.body.accounts).toEqual(accountsOf(ALL.filter((a) => a.row.parent === parent)));
      }
    });

    it('an address that created nothing, or that is no address, → count 0 (the original did not check it)', async () => {
      for (const parent of [
        'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
        'zzz',
        PARENT_3.toLowerCase(),
        `${PARENT_3} `,
        "x' OR 1=1 --",
      ]) {
        const res = await get(`/v2/accounts${qs({ parent })}`);
        expect([parent, res.status, res.body]).toEqual([parent, 200, { result: 'success', count: 0, accounts: [] }]);
      }
    });

    it('an empty parent is no parent; a repeated one: the first wins', async () => {
      expect((await get('/v2/accounts?parent=')).body.count).toBe(13);
      const res = await get(`/v2/accounts?parent=${PARENT_3}&parent=${PARENT_9}`);
      expect(res.body.count).toBe(3);
    });

    it('goes with the window, the pages and the direction', async () => {
      const window = `/v2/accounts?parent=${PARENT_9}&start=2013-06-11T20:01:20Z&end=2013-06-11T20:01:20Z`;
      expect((await get(window)).body.count).toBe(9);
      expect((await get(`/v2/accounts?parent=${PARENT_9}&start=2013-06-11T20:01:21Z`)).body.count).toBe(0);

      const unpaged = await get(`/v2/accounts?parent=${PARENT_9}&limit=1000`);
      const paged = await pages(`/v2/accounts?parent=${PARENT_9}`, 2);
      expect(paged).toHaveLength(5);
      expect(paged.flatMap((p) => p.accounts)).toEqual(unpaged.body.accounts);
      const desc = await pages(`/v2/accounts?parent=${PARENT_9}&descending=true`, 4);
      expect(desc.flatMap((p) => p.accounts)).toEqual([...unpaged.body.accounts].reverse());
    });

    it('is bound as a parameter', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await get(`/v2/accounts?parent=${PARENT_3}`);
      const lists = query.mock.calls.filter(([q]) => String(q).includes(Table.AccountsCreated));
      expect(lists).toHaveLength(1);
      expect(String(lists[0][0])).toMatch(/AND parent = \{parent:String\}/);
      expect(String(lists[0][0])).not.toContain(PARENT_3);
      expect(lists[0][1]).toMatchObject({ parent: PARENT_3 });
      // without a parent the filter is not there
      query.mockClear();
      await get('/v2/accounts');
      const plain = query.mock.calls.filter(([q]) => String(q).includes(Table.AccountsCreated));
      expect(String(plain[0][0])).not.toMatch(/parent = /);
      expect(plain[0][1]).not.toHaveProperty('parent');
    });
  });

  // -- the order of the checks ------------------------------------------------------------------------------------

  describe('the checks', () => {
    it('come in the order of the original: start, end, then the marker', async () => {
      const cases: [string, string][] = [
        [`/v2/accounts${qs({ start: 'x', end: 'y', marker: '!' })}`, 'invalid start date format'],
        [`/v2/accounts${qs({ end: 'y', marker: '!' })}`, 'invalid end date format'],
        [`/v2/accounts${qs({ marker: '!' })}`, 'invalid marker'],
      ];
      for (const [url, message] of cases) {
        const res = await get(url);
        expect([url, res.status, res.body]).toEqual([url, 400, { result: 'error', message }]);
      }
    });

    it('a marker of another list, or made up, → 400 invalid marker', async () => {
      const wrongShape = Buffer.from(JSON.stringify([1021029, 0]), 'utf8').toString('base64url');
      const wrongType = Buffer.from(JSON.stringify(['x', 0, 'r']), 'utf8').toString('base64url');
      const notJson = Buffer.from('nonsense', 'utf8').toString('base64url');
      for (const marker of [wrongShape, wrongType, notJson, '20130611200120|000001021029|00001', '!!', 'e30']) {
        const res = await get(`/v2/accounts${qs({ marker })}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
    });

    it('a marker is checked even when the range is empty', async () => {
      const res = await get('/v2/accounts?start=2030-01-01&marker=!');
      expect([res.status, res.body.message]).toEqual([400, 'invalid marker']);
    });
  });

  // -- the shared list behaviour ---------------------------------------------------------------------------------

  describe('the list', () => {
    it('empty range → count 0', async () => {
      const res = await get('/v2/accounts?start=2030-01-01&end=2030-12-31');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: 'success', count: 0, accounts: [] });
      expect(res.headers.link).toBeUndefined();
    });

    it('a start after the last ledger → count 0; an end before the first → count 0; an end before the start → count 0', async () => {
      expect((await get('/v2/accounts?start=2018-01-01')).body.count).toBe(0);
      expect((await get('/v2/accounts?end=2013-06-01')).body.count).toBe(0);
      expect((await get('/v2/accounts?start=2015-01-01&end=2014-01-01')).body.count).toBe(0);
    });

    it('marker pages concatenate to unpaged list', async () => {
      const unpaged = await get('/v2/accounts?limit=1000');
      expect(unpaged.body.count).toBe(13);
      expect(unpaged.body.marker).toBeUndefined();
      expect(unpaged.headers.link).toBeUndefined();

      // 3 pages cut inside ledger 1021029, which holds 9 accounts
      for (const limit of [1, 2, 3, 4, 5, 9, 12]) {
        const paged = await pages('/v2/accounts', limit);
        expect(paged.slice(0, -1).every((p) => p.count === limit && p.marker !== undefined)).toBe(true);
        expect(paged[paged.length - 1].marker).toBeUndefined();
        expect([limit, paged.flatMap((p) => p.accounts)]).toEqual([limit, unpaged.body.accounts]);
      }
    });

    it('marker pages concatenate inside a window too', async () => {
      const window = '/v2/accounts?start=2013-01-14T18:28:40&end=2013-07-01';
      const unpaged = await get(`${window}&limit=1000`);
      expect(unpaged.body.count).toBe(9);
      const paged = await pages(window, 4);
      expect(paged).toHaveLength(3);
      expect(paged.flatMap((p) => p.accounts)).toEqual(unpaged.body.accounts);
    });

    it('descending reverses order', async () => {
      const asc = await get('/v2/accounts?limit=1000');
      const desc = await get('/v2/accounts?limit=1000&descending=true');
      expect(asc.body.count).toBe(13);
      expect(desc.body.accounts).toEqual([...asc.body.accounts].reverse());
      // the markers of a descending list continue downwards
      for (const limit of [1, 4, 7]) {
        const pagedDesc = await pages('/v2/accounts?descending=true', limit);
        expect([limit, pagedDesc.flatMap((p) => p.accounts)]).toEqual([limit, desc.body.accounts]);
      }
    });

    it('descending: false and anything but /true/i is ascending', async () => {
      const asc = await get('/v2/accounts?limit=5');
      for (const flag of ['false', '1', '0', '']) {
        expect((await get(`/v2/accounts?limit=5&descending=${flag}`)).body).toEqual(asc.body);
      }
      const desc = await get('/v2/accounts?limit=5&descending=true');
      expect((await get('/v2/accounts?limit=5&descending=TRUE')).body).toEqual(desc.body);
      expect(namesIn(desc.body)).toEqual(namesOf(ALL.slice(-5).reverse()));
    });

    it('unknown params ignored', async () => {
      const plain = await get('/v2/accounts?limit=5');
      const res = await get(
        '/v2/accounts?limit=5&foo=bar&interval=day&reduce=true&account=rGTvj2qFEYunK7vnWeWmxwvTcL2svvVP7b',
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get('/v2/accounts?limit=3&limit=50&descending=true&descending=false');
      expect(res.body.count).toBe(3);
      expect(namesIn(res.body)).toEqual(namesOf(ALL.slice(-3).reverse()));
    });

    it('start and end are the accounts created within them; a date with less than a second is the whole period', async () => {
      const cases: [Record<string, string>, string, string][] = [
        [{ start: '2013-06-11', end: '2013-06-11' }, '2013-06-11T00:00:00', '2013-06-12T00:00:00'],
        [{ start: '2013-06-11T20:01', end: '2013-06-11T20:01' }, '2013-06-11T20:01:00', '2013-06-11T20:02:00'],
        [{ start: '2013-06-11T20:01:20Z', end: '2013-06-11T20:01:20Z' }, '2013-06-11T20:01:20', '2013-06-11T20:01:21'],
        [{ start: '2013-10' }, '2013-10-01T00:00:00', '2100-01-01T00:00:00'],
        [{ end: '2013-12' }, '2000-01-01T00:00:00', '2014-01-01T00:00:00'],
        [{ start: '2015' }, '2015-01-01T00:00:00', '2100-01-01T00:00:00'],
        [{ start: '2013-06-11T20:01:21Z' }, '2013-06-11T20:01:21', '2100-01-01T00:00:00'],
      ];
      for (const [params, from, before] of cases) {
        const expected = createdBetween(from, before);
        expect(expected.length).toBeGreaterThan(0);
        const listed = (await pages(`/v2/accounts${qs(params)}`, 100)).flatMap(namesIn);
        expect([params, listed]).toEqual([params, namesOf(expected)]);
      }
    });

    it('start defaults to 2013-01-01; an empty start is the default, an empty end is invalid', async () => {
      expect((await get('/v2/accounts?start=')).body.count).toBe(13);
      expect((await get('/v2/accounts?start=2013-01-01')).body.count).toBe(13);
      const res = await get('/v2/accounts?end=');
      expect([res.status, res.body.message]).toEqual([400, 'invalid end date format']);
    });

    it('invalid dates in every form the original rejects', async () => {
      for (const start of ['2015-13-01', '2015-02-30', 'yesterday', '12-12-2014', '2015-01-14T25:00:00', '0']) {
        const res = await get(`/v2/accounts${qs({ start })}`);
        expect([start, res.status, res.body.message]).toEqual([start, 400, 'invalid start date format']);
      }
    });

    // -- limit --

    it('limit is 200 by default, at most 1000; below one or not a number it is the default', async () => {
      const cases: [string, number][] = [
        ['', 200],
        ['limit=1', 1],
        ['limit=7', 7],
        ['limit=1000', 1000],
        ['limit=1001', 1000],
        ['limit=100000', 1000],
        ['limit=0', 200],
        ['limit=-5', 200],
        ['limit=abc', 200],
        ['limit=', 200],
        ['limit=2.9', 2],
      ];
      for (const [query, rows] of cases) {
        const spy = jest.spyOn(h.ch, 'query');
        const res = await get(`/v2/accounts?${query}`);
        // one more than the page is asked for: the extra row tells whether there is a next page
        const paging = spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.AccountsCreated}\\b`).test(String(q)));
        expect([query, res.status, paging[0][1]]).toEqual([query, 200, expect.objectContaining({ fetch: rows + 1 })]);
        expect([query, res.body.count]).toEqual([query, Math.min(rows, 13)]);
        jest.restoreAllMocks();
      }
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      const last = await get('/v2/accounts?limit=1000');
      expect(last.body.marker).toBeUndefined();
      expect(last.headers.link).toBeUndefined();

      // exactly as many as the limit: no marker either
      const exact = await get('/v2/accounts?limit=13');
      expect(exact.body.count).toBe(13);
      expect(exact.body.marker).toBeUndefined();
      expect(exact.headers.link).toBeUndefined();

      // one fewer: the marker is the key of the last account that is returned
      const more = await get('/v2/accounts?limit=12');
      expect(more.body.count).toBe(12);
      expect(more.body.marker).toBe(markerOf(ALL[11].row));
      const rest = await get(`/v2/accounts?limit=12&marker=${more.body.marker}`);
      expect(rest.body.accounts).toEqual(accountsOf(ALL.slice(12)));
    });

    it('a marker continues strictly after (before, descending) its row', async () => {
      for (const i of [0, 4, 8, 9, 11]) {
        const asc = await get(`/v2/accounts?limit=1000&marker=${markerOf(ALL[i].row)}`);
        expect([i, namesIn(asc.body)]).toEqual([i, namesOf(ALL.slice(i + 1))]);
        const desc = await get(`/v2/accounts?limit=1000&descending=true&marker=${markerOf(ALL[i].row)}`);
        expect([i, namesIn(desc.body)]).toEqual([i, namesOf(ALL.slice(0, i).reverse())]);
      }
      const end = await get(`/v2/accounts?marker=${markerOf(ALL[12].row)}`);
      expect(end.body).toEqual({ result: 'success', count: 0, accounts: [] });
    });

    it('a marker made up of the key of a row that does not exist still continues after that key', async () => {
      // after ledger 1021029, tx 8 (no account was created by it): the accounts of tx 9 and later
      const res = await get(
        `/v2/accounts?limit=1000&marker=${markerOf({ ledger_index: 1021029, tx_index: 8, account: 'a' })}`,
      );
      expect(namesIn(res.body)).toEqual(namesOf(ALL.slice(6)));
    });

    it('a marker does not matter when the range is empty', async () => {
      const res = await get(`/v2/accounts?start=2030-01-01&marker=${markerOf(ALL[3].row)}`);
      expect(res.body).toEqual({ result: 'success', count: 0, accounts: [] });
    });

    it('a marker is not tied to the window it came from', async () => {
      const first = await get('/v2/accounts?limit=2&start=2013-01-01');
      const res = await get(`/v2/accounts?limit=1000&marker=${first.body.marker}&start=2013-10-01`);
      expect(namesIn(res.body)).toEqual(namesOf(ALL.slice(9)));
    });

    it('the Link header keeps the query and puts the marker last', async () => {
      const res = await get(`/v2/accounts?limit=2&parent=${PARENT_9}&descending=true`);
      const origin = new URL(res.request.url).origin;
      expect(res.headers.link).toBe(
        `<${origin}/v2/accounts?limit=2&parent=${PARENT_9}&descending=true&marker=${res.body.marker}>; rel="next"`,
      );
    });

    it('is 500 unable to get accounts when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      const res = await get('/v2/accounts');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ result: 'error', message: 'unable to get accounts' });
    });

    it('is 500 unable to get accounts when the page fails after the range was found', async () => {
      const real = h.ch.query.bind(h.ch);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sql.includes(Table.AccountsCreated)
          ? Promise.reject(new Error('boom'))
          : (real as any)(sql, ...rest)) as never);
      for (const path of ['/v2/accounts', `/v2/accounts/${FIRST}`]) {
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([
          path,
          500,
          { result: 'error', message: 'unable to get accounts' },
        ]);
      }
    });
  });

  // -- CSV --------------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('format=csv → text/csv, accounts.csv, one row per account', async () => {
      const res = await get('/v2/accounts?format=csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe('attachment; filename=accounts.csv');
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 13);
      expect(rows[0].split(',')).toEqual([
        '"account"',
        '"parent"',
        '"initial_balance"',
        '"inception"',
        '"ledger_index"',
        '"tx_hash"',
      ]);
      expect(rows[1]).toBe(`"${FIRST}","${PARENT_9}","1000","2013-06-11T20:01:20Z","1021029","${ALL[0].row.tx_hash}"`);
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get('/v2/accounts?format=CSV&limit=1')).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`/v2/accounts?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page, and the same rows as the JSON', async () => {
      const csv = await get('/v2/accounts?format=csv&limit=3');
      const json = await get('/v2/accounts?limit=3');
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/accounts?format=csv&limit=3&marker=${json.body.marker}>; rel="next"`,
      );
      const rows = lines(csv.text);
      expect(rows).toHaveLength(1 + 3);
      json.body.accounts.forEach((a: Record<string, unknown>, i: number) =>
        expect(rows[i + 1]).toContain(`"${a.tx_hash}"`),
      );
      // the last page has none
      expect((await get('/v2/accounts?format=csv&limit=1000')).headers.link).toBeUndefined();
    });

    it('goes with the parent, the window and the direction', async () => {
      const res = await get(`/v2/accounts?format=csv&parent=${PARENT_3}&descending=true`);
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 3);
      expect(rows[1]).toContain(`"${ALL[11].row.account}"`);
      expect((await get('/v2/accounts?format=csv&start=2015')).text.split('\n')).toHaveLength(2);
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      const empty = await get('/v2/accounts?format=csv&start=2030-01-01');
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get('/v2/accounts?format=csv&start=x');
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'invalid start date format' });
    });
  });

  // -- storage ----------------------------------------------------------------------------------------------------

  describe('the query', () => {
    const accountsSql = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(([q]) => new RegExp(`FROM ${Table.AccountsCreated}\\b`).test(String(q)))
        .map(([q, p]) => [String(q), p as Record<string, unknown>]);

    it('pages accounts_created by ledger range with the whole key in the ORDER BY and the cursor, and dedupes by it', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get(`/v2/accounts?limit=4&marker=${markerOf(ALL[2].row)}`);
      expect(res.body.count).toBe(4);
      const [[sql, params]] = accountsSql(spy);
      expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
      expect(sql).toMatch(/\(ledger_index, tx_index, account\) > \(\{k0:UInt32\}, \{k1:UInt32\}, \{k2:String\}\)/);
      expect(sql).toMatch(/ORDER BY ledger_index ASC, tx_index ASC, account ASC/);
      // a row that was written twice counts once
      expect(sql).toMatch(/LIMIT 1 BY ledger_index, tx_index, account\s+LIMIT \{fetch:UInt32\}/);
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(params).toMatchObject({ min: 1021029, k0: 1021029, k1: 2, k2: ALL[2].row.account, fetch: 5 });
      expect(Object.keys(params).sort()).toEqual(['fetch', 'k0', 'k1', 'k2', 'max', 'min']);
    });

    it('descending reads the same key backwards', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`/v2/accounts?limit=4&descending=true&marker=${markerOf(ALL[9].row)}`);
      const [[sql]] = accountsSql(spy);
      expect(sql).toMatch(/\(ledger_index, tx_index, account\) < \(/);
      expect(sql).toMatch(/ORDER BY ledger_index DESC, tx_index DESC, account DESC/);
    });

    it('reads the table in the order of its primary key, so that a page never sorts the whole range', async () => {
      // the table is not partitioned and ORDER BY (ledger_index, tx_index, account): with the whole key spelled out,
      // ClickHouse reads it in that order and stops after the page; the plan has no sorting step
      const variants: string[] = [
        `limit=5`,
        `limit=5&marker=${markerOf(ALL[2].row)}`,
        `limit=5&parent=${PARENT_3}`,
        `limit=5&start=2013-06-11&end=2015-12-31&marker=${markerOf(ALL[2].row)}`,
      ];
      for (const descending of [false, true]) {
        for (const variant of variants) {
          const spy = jest.spyOn(h.ch, 'query');
          const marker = /marker=/.test(variant)
            ? variant.replace(/marker=[^&]+/, `marker=${markerOf(ALL[descending ? 10 : 2].row)}`)
            : variant;
          await get(`/v2/accounts?${marker}&descending=${descending}`);
          const [[sql, params]] = accountsSql(spy);
          jest.restoreAllMocks();

          const plan = await h.ch.query<{ explain: string }>(`EXPLAIN PIPELINE ${sql}`, params);
          const pipeline = plan.map((r) => r.explain).join('\n');
          expect([descending, variant, pipeline]).toEqual([
            descending,
            variant,
            expect.stringContaining('ReadPoolInOrder'),
          ]);
          expect(pipeline).toContain(descending ? 'InReverseOrder' : 'algorithm: InOrder');
          expect(pipeline).not.toContain('PartialSortingTransform');
        }
      }
    });

    it('looks an address up through the bloom filter on account, reading the newest key first', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`/v2/accounts/${FIRST}`);
      const [[sql, params]] = accountsSql(spy);
      jest.restoreAllMocks();
      expect(params).toEqual({ account: FIRST });

      const indexes = await h.ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params);
      expect(indexes.map((r) => r.explain).join('\n')).toContain('account_bf');
      const plan = await h.ch.query<{ explain: string }>(`EXPLAIN PIPELINE ${sql}`, params);
      const pipeline = plan.map((r) => r.explain).join('\n');
      expect(pipeline).toContain('InReverseOrder');
      expect(pipeline).not.toContain('PartialSortingTransform');
    });

    it('does not use a list for the lookup: one row is read, and the list reads no more than a page', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`/v2/accounts/${FIRST}`);
      await get('/v2/accounts?limit=2');
      const calls = accountsSql(spy);
      expect(calls).toHaveLength(2);
      expect(calls[0][0]).toMatch(/LIMIT 1\b/);
      expect(calls[1][1]).toMatchObject({ fetch: 3 });
    });
  });
});

describe('accounts API endpoint when a ledger was written twice', () => {
  // The table is a ReplacingMergeTree and the lists never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about).
  const LEDGER = 1021029;
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'accounts');
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AccountsCreated}`);
    await h.ch.command(
      `INSERT INTO ${Table.AccountsCreated} SELECT * FROM ${Table.AccountsCreated} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.AccountsCreated} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
    );
    expect(Number(n)).toBe(18);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every account once', async () => {
    const unpaged = await get('/v2/accounts?limit=1000');
    expect(unpaged.body.count).toBe(13);
    expect(unpaged.body.accounts).toEqual(accountsOf(ALL));
    // and a page cut inside the duplicates neither repeats nor skips a row
    for (const limit of [1, 2, 3, 5]) {
      const paged = (await pages('/v2/accounts', limit)).flatMap(namesIn);
      expect([limit, paged]).toEqual([limit, namesOf(ALL)]);
    }
    const desc = await pages('/v2/accounts?descending=true', 2);
    expect(desc.flatMap(namesIn)).toEqual(namesOf(ALL).reverse());
  });

  it('lists the accounts of a parent once', async () => {
    const res = await get(`/v2/accounts?parent=${PARENT_9}&limit=1000`);
    expect(res.body.count).toBe(9);
    expect((await pages(`/v2/accounts?parent=${PARENT_9}`, 2)).flatMap(namesIn)).toEqual(
      namesOf(ALL.filter((a) => a.row.parent === PARENT_9)),
    );
  });

  it('looks an account up in spite of its two rows', async () => {
    const res = await get(`/v2/accounts/${FIRST}`);
    expect(res.status).toBe(200);
    expect(res.body.account_data).toEqual(accountOf(ALL[0].row));
  });
});

describe('accounts API endpoint on accounts the mock ledgers do not have', () => {
  // An AccountDelete followed by a new payment to the same address creates the account twice, and one transaction can
  // create more than one account. The mock ledgers have neither, so the rows are written here.
  const ACCOUNT = 'rGTvj2qFEYunK7vnWeWmxwvTcL2svvVP7b'; // created in ledger 1021029, tx 1
  const hash = (c: string): string => c.repeat(64);
  const extra = (
    row: Partial<AccountsCreatedRow> & Pick<AccountsCreatedRow, 'account' | 'ledger_index' | 'tx_index'>,
  ) => ({
    parent: PARENT_1,
    initial_balance: '25.5',
    tx_hash: hash('A'),
    inception: 0,
    genesis_balance: null,
    genesis_index: null,
    ...row,
  });

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  let rows: AccountsCreatedRow[];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'accounts');

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    const closed = async (ledger: number): Promise<number> =>
      Number(
        (
          await h.ch.query<{ t: string }>(
            `SELECT toUnixTimestamp(close_time) AS t FROM ledgers WHERE ledger_index = {ledger:UInt32}`,
            { ledger },
          )
        )[0].t,
      );
    const t2015 = await closed(11618225);
    const t2013 = await closed(2964124);
    const tLast = await closed(29709909);
    const added = [
      // re-funded twice after an AccountDelete: the latest is the one of tx 12
      extra({
        account: ACCOUNT,
        ledger_index: 11618225,
        tx_index: 9,
        inception: t2015,
        tx_hash: hash('B'),
        initial_balance: '25.5',
      }),
      extra({
        account: ACCOUNT,
        ledger_index: 11618225,
        tx_index: 12,
        inception: t2015,
        tx_hash: hash('C'),
        parent: PARENT_3,
        initial_balance: '30.000001',
      }),
      // a lower ledger but a higher tx_index: not the latest
      extra({
        account: ACCOUNT,
        ledger_index: 2964124,
        tx_index: 99,
        inception: t2013,
        tx_hash: hash('D'),
        initial_balance: '7',
      }),
      // one transaction that created two accounts
      extra({
        account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
        ledger_index: 29709909,
        tx_index: 0,
        inception: tLast,
        tx_hash: hash('E'),
      }),
      extra({
        account: 'rrrrrrrrrrrrrrrrrrrrBZbvji',
        ledger_index: 29709909,
        tx_index: 0,
        inception: tLast,
        tx_hash: hash('E'),
      }),
      extra({
        account: 'rrrrrrrrrrrrrrrrrrrrNHCMTa',
        ledger_index: 29709909,
        tx_index: 0,
        inception: tLast,
        tx_hash: hash('E'),
      }),
    ];
    await h.ch.insert(Table.AccountsCreated, added);
    rows = [...ALL.map((a) => a.row), ...added].sort(
      (a, b) =>
        a.ledger_index - b.ledger_index ||
        a.tx_index - b.tx_index ||
        (a.account < b.account ? -1 : a.account > b.account ? 1 : 0),
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the lookup is the latest creation: highest ledger, then highest transaction', async () => {
    const res = await get(`/v2/accounts/${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(res.body.account_data).toEqual({
      account: ACCOUNT,
      parent: PARENT_3,
      initial_balance: '30.000001',
      inception: '2015-02-09T20:30:00Z',
      ledger_index: 11618225,
      tx_hash: hash('C'),
    });
  });

  it('the list has every creation, each at its place', async () => {
    const res = await get('/v2/accounts?limit=1000');
    expect(res.body.count).toBe(19);
    expect(res.body.accounts).toEqual(rows.map(accountOf));
    expect(
      res.body.accounts
        .filter((a: Record<string, unknown>) => a.account === ACCOUNT)
        .map((a: Record<string, unknown>) => a.ledger_index),
    ).toEqual([1021029, 2964124, 11618225, 11618225]);
  });

  it('a transaction that created three accounts pages without skipping or repeating any', async () => {
    const unpaged = await get('/v2/accounts?limit=1000');
    for (const limit of [1, 2, 3, 4]) {
      const paged = await pages('/v2/accounts', limit);
      expect([limit, paged.flatMap((p) => p.accounts)]).toEqual([limit, unpaged.body.accounts]);
      const desc = await pages('/v2/accounts?descending=true', limit);
      expect([limit, desc.flatMap((p) => p.accounts)]).toEqual([limit, [...unpaged.body.accounts].reverse()]);
    }
    // the three share (ledger_index, tx_index): the account is what the marker tells them apart by
    const window = '/v2/accounts?start=2017-01-01';
    const tail = await get(`${window}&limit=1000`);
    expect(namesIn(tail.body)).toEqual([
      'rrrrrrrrrrrrrrrrrrrrBZbvji',
      'rrrrrrrrrrrrrrrrrrrrNHCMTa',
      'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
    ]);
    const walked = (await pages(window, 1)).flatMap(namesIn);
    expect(walked).toEqual(namesIn(tail.body));
    const marker = markerOf({ ledger_index: 29709909, tx_index: 0, account: 'rrrrrrrrrrrrrrrrrrrrNHCMTa' });
    expect(namesIn((await get(`${window}&marker=${marker}`)).body)).toEqual(['rrrrrrrrrrrrrrrrrrrrrhoLvTp']);
  });

  it('the parent filter finds every creation of the parent', async () => {
    const res = await get(`/v2/accounts?parent=${PARENT_3}&limit=1000`);
    expect(res.body.count).toBe(4);
    expect(res.body.accounts.at(-1).tx_hash).toBe(hash('C'));
    expect((await get(`/v2/accounts?parent=${PARENT_1}&limit=1000`)).body.count).toBe(1 + 1 + 1 + 3);
  });

  it('genesis_balance and genesis_index are served when a row has them, as a string and a number', async () => {
    await h.ch.insert(Table.AccountsCreated, [
      extra({
        account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        ledger_index: 11618225,
        tx_index: 20,
        inception: 1423513800,
        genesis_balance: '100000000000',
        genesis_index: 32570,
      }),
    ]);
    const res = await get('/v2/accounts/rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
    expect(res.body.account_data).toMatchObject({ genesis_balance: '100000000000', genesis_index: 32570 });
    expect(Object.keys(res.body.account_data)).toEqual([
      'account',
      'parent',
      'initial_balance',
      'inception',
      'ledger_index',
      'tx_hash',
      'genesis_balance',
      'genesis_index',
    ]);
    const csv = await get('/v2/accounts?format=csv&limit=1000');
    expect(csv.text.split('\n')[0]).toContain('"genesis_balance","genesis_index"');
  });
});

describe('accounts API endpoint on Xahau', () => {
  // The recorded Xahau ledgers create no account, so the rows are synthetic: the ledgers are the real ones.
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  let ledgers: { ledger_index: number; close_time: number }[];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'accounts');
  const NEW = [
    ['rHTaDFHJng6YVtThvv522LmJfkocBVkK6Z', '10.5', 0, 0],
    ['rGTvj2qFEYunK7vnWeWmxwvTcL2svvVP7b', '0.000001', 0, 1],
    ['rhYjnjBj6umynq5V5DBWprKTenjXbA9WAR', '1000', 2, 3],
    ['rrpDJrsfaXFCzvDQ1fVeKWbG7fwYiT1nXZ', '5', 4, 0],
  ] as const;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    ledgers = (
      await h.ch.query<{ ledger_index: number; close_time: number }>(
        `SELECT ledger_index, toUnixTimestamp(close_time) AS close_time FROM ledgers ORDER BY ledger_index`,
      )
    ).map((l) => ({ ledger_index: Number(l.ledger_index), close_time: Number(l.close_time) }));
    expect(ledgers).toHaveLength(6);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the recorded ledgers create no account: count 0, and every address is 404', async () => {
    expect(fixtureAccountsCreated('xahau-recorded')).toHaveLength(0);
    expect((await get('/v2/accounts')).body).toEqual({ result: 'success', count: 0, accounts: [] });
    const res = await get(`/v2/accounts/${NEW[0][0]}`);
    expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'Account not found' }]);
  });

  describe('with accounts created', () => {
    beforeAll(async () => {
      await h.ch.insert(
        Table.AccountsCreated,
        NEW.map(([account, balance, ledger, tx], i) => ({
          account,
          parent: i < 3 ? 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y' : 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q',
          initial_balance: balance,
          ledger_index: ledgers[ledger].ledger_index,
          tx_index: tx,
          tx_hash: String(i + 1).repeat(64),
          inception: ledgers[ledger].close_time,
          genesis_balance: null,
          genesis_index: null,
        })),
      );
    });

    it('lists them in the order of the ledgers, with the same fields as on XRPL', async () => {
      const res = await get('/v2/accounts');
      expect(res.body.count).toBe(4);
      expect(res.body.accounts).toEqual(
        NEW.map(([account, balance, ledger, tx], i) => ({
          account,
          parent: i < 3 ? 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y' : 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q',
          initial_balance: balance,
          inception: inceptionOf(ledgers[ledger].close_time),
          ledger_index: ledgers[ledger].ledger_index,
          tx_hash: String(i + 1).repeat(64),
        })),
      );
      for (const a of res.body.accounts) expect(typeof a.initial_balance).toBe('string');
    });

    it('the lookup, the parent filter, the window, the pages and the direction work as on XRPL', async () => {
      const one = await get(`/v2/accounts/${NEW[1][0]}`);
      expect(one.body.account_data).toMatchObject({
        account: NEW[1][0],
        initial_balance: '0.000001',
        tx_hash: '2'.repeat(64),
      });
      expect((await get('/v2/accounts?parent=rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q')).body.count).toBe(1);
      expect((await get('/v2/accounts?parent=rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y')).body.count).toBe(3);

      const at = (i: number): string => inceptionOf(ledgers[i].close_time).slice(0, 19);
      const third = await get(`/v2/accounts?start=${at(2)}&end=${at(2)}`);
      expect(namesIn(third.body)).toEqual([NEW[2][0]]);
      expect((await get('/v2/accounts?start=2030-01-01')).body.count).toBe(0);

      const unpaged = await get('/v2/accounts?limit=1000');
      expect((await pages('/v2/accounts', 1)).flatMap((p) => p.accounts)).toEqual(unpaged.body.accounts);
      expect((await get('/v2/accounts?descending=true')).body.accounts).toEqual([...unpaged.body.accounts].reverse());
    });

    it('format=csv is accounts.csv', async () => {
      const res = await get('/v2/accounts?format=csv');
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe('attachment; filename=accounts.csv');
      expect(res.text.split('\n')).toHaveLength(1 + 4);
    });
  });
});
