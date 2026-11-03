import { MPT_PARSER_VERSION, mptIssuanceId, Table } from '@gatehub/data-api-shared';
import { COVERAGE_KEYS } from '../src/common/feature-coverage.service';
import { MPT_TOKEN_CSV_COLUMNS, MPT_TOKEN_ROW_KEYS, MPT_TOKENS_TOTALS_KEYS } from '../src/mpt/mpt-objects';
import { encodeTokenListMarker, TOKEN_LIST_KEYS } from '../src/tokens/token-list';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, cells, compare, lines } from './support/amm';
import { csvDisposition } from './support/csv';
import {
  expectNoMptRead,
  MPT_WORLD,
  mptHolderRow,
  mptIssuanceRow,
  mptTransferRow,
  seedMptWorld,
} from './support/mpt-world';
import { ledgerRow } from './support/validators-seed';

/**
 * `GET /v2/tokens?kind=mpt` (D9, spec 7.1) on a real ClickHouse, over the world of the MPT suites and three more issuances: two of
 * another issuer, with as many holders as an issuance of the world, so that the order goes on to the issuer and then the ID, and a third
 * whose name is the only thing a search finds of it. D6's route, envelope and checks are its own suite's (`tokens.e2e-spec.ts`).
 */

type Obj = Record<string, unknown>;

const { ids, issuer, holders, head, headClose } = MPT_WORLD;
const COVERAGE = { from_ledger_index: 99_226_369, complete: true };
const OTHER_ISSUER = accountAt(0xa002);
const EARLY = mptIssuanceId(1, OTHER_ISSUER);
const LATE = mptIssuanceId(2, OTHER_ISSUER);
const NAMED = mptIssuanceId(310, issuer);
/** The holder only `EARLY` has. */
const NEW_HOLDER = accountAt(0xb0ff);
const EMPTY_HOLDER = accountAt(0xb0fe);
const GONE_HOLDER = accountAt(0xb0fd);

/** `entry` has the keys of `order` it has, and in that order: none out of place, none made up. */
function expectKeysInOrder(entry: object, order: readonly string[]): void {
  const keys = Object.keys(entry);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

interface Page {
  marker?: string;
  tokens: Obj[];
}

const idsIn = (body: { tokens: Obj[] }): unknown[] => body.tokens.map((row) => row.mpt_issuance_id);

const HTF_FLAGS = {
  locked: false,
  can_lock: true,
  require_auth: true,
  can_escrow: false,
  can_trade: true,
  can_transfer: true,
  can_clawback: true,
};

describe('GET /v2/tokens?kind=mpt over the MPT world', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const list = (query = ''): string => `/v2/tokens?kind=mpt${query}`;
  /** Bare has 6 holders, then 3 of three issuers in order of issuer and ID, then 2, then 1, then the one with none. */
  const ORDER = (): string[] => {
    const three = [
      { id: ids.htf, by: issuer },
      { id: EARLY, by: OTHER_ISSUER },
      { id: LATE, by: OTHER_ISSUER },
    ]
      .sort((a, b) => compare(a.by, b.by) || compare(a.id, b.id))
      .map((row) => row.id);
    return [ids.bare, ...three, ids.lockedAll, ids.escrow, NAMED];
  };

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await seedMptWorld(h);
    await h.ch.insert(Table.MptIssuances, [
      mptIssuanceRow(EARLY, { issuer: OTHER_ISSUER, holders: 3, ticker: 'EAR', outstanding_amount: '30' }),
      mptIssuanceRow(LATE, { issuer: OTHER_ISSUER, holders: 3, ticker: 'LAT', outstanding_amount: '31' }),
      mptIssuanceRow(NAMED, { name: 'Ünicode Harbour Note' }),
    ]);
    // of EARLY and LATE: one holder only they have, one with nothing, and one whose newest row deleted its token
    await h.ch.insert(Table.MptHolders, [
      mptHolderRow(EARLY, NEW_HOLDER, '30'),
      mptHolderRow(EARLY, EMPTY_HOLDER, '0'),
      mptHolderRow(LATE, GONE_HOLDER, '5', { version: '100' }),
    ]);
    await h.ch.insert(Table.MptHolders, [mptHolderRow(LATE, GONE_HOLDER, '0', { deleted: 1 })]);
    // a payment of the window of an issuance the list leaves out: it counts in the totals of the kind
    await h.ch.insert(Table.MptTransfers, [
      mptTransferRow(ids.unknownState, head, 3, 'payment', holders[9], holders[0], '1'),
    ]);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('is D6 envelope, with the MPT row and totals in key order', async () => {
    const { body } = await api.ok(list(), 'tokens');
    expect(Object.keys(body)).toEqual(TOKEN_LIST_KEYS.filter((key) => !['total_below', 'marker'].includes(key)));
    expect(body.coverage).toEqual(COVERAGE);
    expect(Object.keys(body.coverage)).toEqual([...COVERAGE_KEYS]);
    expect(body.kind).toBe('mpt');
    expect(body.ledger_index).toBe(head);
    expect(body.close_time).toBe('2026-10-24T14:20:01Z');
    expect(Object.keys(body.totals)).toEqual([...MPT_TOKENS_TOTALS_KEYS]);
    for (const row of body.tokens) expectKeysInOrder(row, MPT_TOKEN_ROW_KEYS);
    const htf = body.tokens.find((row: Obj) => row.mpt_issuance_id === ids.htf);
    expect(JSON.stringify(htf)).toBe(
      JSON.stringify({
        rank: htf.rank,
        mpt_issuance_id: ids.htf,
        issuer,
        ticker: 'HTF',
        name: 'Harborline Treasury Fund',
        asset_scale: 2,
        maximum_amount: '5000000000',
        outstanding_amount: '1820451120',
        holders: 3,
        transfer_fee: 100,
        flags: HTF_FLAGS,
        transfers_24h: 2,
      }),
    );
  });

  it('orders by holders, then issuer, then ID, with rank the place in it; unknown states and destroyed issuances left out', async () => {
    const { body } = await api.ok(list(), 'tokens');
    expect(idsIn(body)).toEqual(ORDER());
    expect(body.tokens.map((row: Obj) => row.rank)).toEqual(ORDER().map((_, i) => i + 1));
    expect(idsIn(body)).not.toContain(ids.unknownState);
    expect(idsIn(body)).not.toContain(ids.destroyed);
    expect(body.total).toBe(7);
    expect(body.count).toBe(7);
    // the newest version of a row counts: 900 holders in an older one would put it first
    expect(body.tokens[0]).toMatchObject({ mpt_issuance_id: ids.bare, holders: 6 });
  });

  it('leaves out what an issuance does not have', async () => {
    const { body } = await api.ok(list(`&q=${ids.bare}`), 'tokens');
    expect(Object.keys(body.tokens[0])).toEqual(
      MPT_TOKEN_ROW_KEYS.filter((key) => !['ticker', 'name', 'maximum_amount'].includes(key)),
    );
    expect(body.tokens[0].outstanding_amount).toBe('18014398509482023');
  });

  describe('q', () => {
    const found = async (q: string): Promise<unknown[]> =>
      idsIn((await api.ok(list(`&q=${encodeURIComponent(q)}`), 'tokens')).body);

    it('a classic address is that issuer', async () => {
      expect(await found(OTHER_ISSUER)).toEqual([EARLY, LATE].sort(compare));
    });

    it('48 hex digits, in either case, are that issuance', async () => {
      expect(await found(ids.htf)).toEqual([ids.htf]);
      expect(await found(ids.htf.toLowerCase())).toEqual([ids.htf]);
      // one the list leaves out stays out
      expect(await found(ids.unknownState)).toEqual([]);
    });

    it('text is in the ticker or the name, in any case', async () => {
      expect(await found('htf')).toEqual([ids.htf]);
      expect(await found('harbo')).toEqual([ids.htf, NAMED]);
      expect(await found('ÜNICODE')).toEqual([NAMED]);
    });

    it('text is the start of an issuer', async () => {
      expect(await found(OTHER_ISSUER.slice(0, 20))).toEqual(expect.arrayContaining([EARLY, LATE]));
      // inside an address is not the start of it
      expect(await found(OTHER_ISSUER.slice(5, 25))).toEqual([]);
    });

    it('8 hex digits or more are the start of an ID, in either case; 7 are not', async () => {
      expect(await found(ids.htf.slice(0, 8))).toEqual([ids.htf]);
      expect(await found(ids.htf.slice(0, 8).toLowerCase())).toEqual([ids.htf]);
      expect(await found(ids.htf.slice(0, 7))).toEqual([]);
    });

    it('binds the search: text that means something to SQL is text', async () => {
      expect(await found("' OR 1=1 --")).toEqual([]);
    });
  });

  describe('min_holders', () => {
    it('keeps the issuances with at least that many, and total_below counts those that match with fewer', async () => {
      const { body } = await api.ok(list('&min_holders=2'), 'tokens');
      expect(idsIn(body)).toEqual(ORDER().slice(0, 5));
      expect([body.total, body.total_below, body.count]).toEqual([5, 2, 5]);
      // total_below comes after total
      expectKeysInOrder(body, TOKEN_LIST_KEYS);
      expect(Object.keys(body)).toContain('total_below');
    });

    it('with a search, total and total_below count over the search', async () => {
      const { body } = await api.ok(list(`&min_holders=4&q=${OTHER_ISSUER}`), 'tokens');
      expect([body.total, body.total_below, body.count]).toEqual([0, 2, 0]);
    });

    it('rank is the place among the selected', async () => {
      const { body } = await api.ok(list(`&q=${OTHER_ISSUER}`), 'tokens');
      expect(body.tokens.map((row: Obj) => row.rank)).toEqual([1, 2]);
    });
  });

  describe('totals', () => {
    const TOTALS = { issuances: 7, holders: 10, transfers_24h: 4 };

    it('are of the whole kind: known and live issuances, their distinct holders, every payment of the window', async () => {
      const { body } = await api.ok(list(), 'tokens');
      expect(body.totals).toEqual(TOTALS);
    });

    it.each(['&min_holders=4', `&q=${OTHER_ISSUER}`, '&q=nothing-matches-this', '&limit=1'])(
      'are the same with %s',
      async (query) => {
        expect((await api.ok(list(query), 'tokens')).body.totals).toEqual(TOTALS);
      },
    );

    it('holders leaves out a holder of an issuance the list leaves out, and a deleted or an empty token', async () => {
      // holders[9] holds only unknownState; EMPTY_HOLDER has nothing; GONE_HOLDER's newest row deleted its token, which held 5
      const [{ n }] = await h.ch.query<{ n: string }>(`SELECT uniqExact(holder) AS n FROM ${Table.MptHolders}`);
      expect(Number(n)).toBe(TOTALS.holders + 3);
    });
  });

  describe('transfers_24h', () => {
    it('counts a payment at headClose - 86399, not one at headClose - 86400, no lock, none above the head, each once', async () => {
      const { body } = await api.ok(list(`&q=${ids.htf}`), 'tokens');
      // (head - 1, 0) and (head, 0); not (head - 2, 0), (head - 1, 1) the lock, (head + 1, 0), and the rows of htf are there twice
      expect(body.tokens[0].transfers_24h).toBe(2);
      expect(head - 2).toBeGreaterThan(0);
      expect(headClose).toBeGreaterThan(86_400);
    });

    it('is 0 for an issuance with none', async () => {
      const { body } = await api.ok(list(`&q=${ids.escrow}`), 'tokens');
      expect(body.tokens[0].transfers_24h).toBe(0);
    });
  });

  describe('the marker', () => {
    it.each([1, 2, 3])('pages with limit=%i into the unpaged list, the ranks going on', async (limit) => {
      const unpaged = (await api.ok(list(), 'tokens')).body.tokens;
      const pages = await api.pages<Page>(list(), limit, 'tokens');
      expect(pages.flatMap((page) => page.tokens)).toEqual(unpaged);
      expect(pages[pages.length - 1].marker).toBeUndefined();
    });

    it('sets the Link of a next page', async () => {
      const res = await get(list('&limit=1'));
      expect(res.headers.link).toContain(`marker=${res.body.marker}`);
      expect(res.headers.link).toContain('kind=mpt');
    });

    it('holds holders, the issuer and the ID of the last row', async () => {
      const res = await get(list('&limit=1'));
      expect(res.body.marker).toBe(encodeTokenListMarker('mpt', 6, issuer, ids.bare));
    });

    it('a marker of issued is invalid marker, and one of mpt is for kind=issued', async () => {
      const issued = await get(list(`&marker=${encodeTokenListMarker('issued', 6, issuer, 'USD')}`));
      expect([issued.status, issued.body]).toEqual([400, { result: 'error', message: 'invalid marker' }]);
      const mpt = await get(`/v2/tokens?marker=${encodeTokenListMarker('mpt', 6, issuer, ids.bare)}`);
      expect([mpt.status, mpt.body]).toEqual([400, { result: 'error', message: 'invalid marker' }]);
      const junk = await get(list('&marker=%25%25'));
      expect([junk.status, junk.body.message]).toEqual([400, 'invalid marker']);
    });

    it('a bad marker is a 400 before any read, the coverage too (ruling C23)', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get(list('&marker=%25%25'));
      const reads = spy.mock.calls.length;
      spy.mockRestore();
      expect([res.status, reads]).toEqual([400, 0]);
    });
  });

  it('serves every amount as an integer string of at most 19 digits (ruling C25)', async () => {
    const { body } = await api.ok(list(), 'tokens');
    const amounts = body.tokens.flatMap((row: Obj) =>
      ['maximum_amount', 'outstanding_amount'].filter((name) => name in row).map((name) => row[name]),
    );
    expect(amounts.length).toBeGreaterThan(7);
    for (const amount of amounts) expect(amount).toEqual(expect.stringMatching(/^\d{1,19}$/));
  });

  it('kind=nft is invalid kind - use: issued, mpt', async () => {
    const res = await get('/v2/tokens?kind=nft');
    expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid kind - use: issued, mpt' }]);
  });

  it('format=csv is tokens.csv: the same columns on every row, the flags flattened, without coverage', async () => {
    const res = await get(list('&format=csv'));
    expect(res.headers['content-disposition']).toBe(csvDisposition('tokens'));
    const rows = lines(res.text);
    expect(rows[0]).toBe(MPT_TOKEN_CSV_COLUMNS.map((column) => `"${column}"`).join(','));
    expect(rows).toHaveLength(8);
    const at = (row: string, column: string): string => cells(row)[MPT_TOKEN_CSV_COLUMNS.indexOf(column as never)];
    // bare, the first, has no ticker and no maximum
    expect(at(rows[1], 'mpt_issuance_id')).toBe(`"${ids.bare}"`);
    expect(at(rows[1], 'ticker')).toBe('""');
    expect(at(rows[1], 'maximum_amount')).toBe('""');
    expect(at(rows[1], 'flags.locked')).toBe('"false"');
    expect(at(rows[1], 'transfers_24h')).toBe('"1"');
    expect(res.text).not.toContain('from_ledger_index');
  });

  it('kind=issued answers as it did: no generation, no MPT', async () => {
    const res = await api.ok('/v2/tokens?kind=issued', 'tokens');
    expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'kind', 'count', 'tokens']);
    expect([res.body.kind, res.body.count, res.body.tokens]).toEqual(['issued', 0, []]);
    expect((await api.ok('/v2/tokens', 'tokens')).body.kind).toBe('issued');
  });

  it('answers 500 unable to retrieve tokens when the database fails', async () => {
    const spy = jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('down'));
    const res = await get(list());
    spy.mockRestore();
    expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve tokens' }]);
  });
});

describe('GET /v2/tokens?kind=mpt with nothing to list', () => {
  const ZERO = { issuances: 0, holders: 0, transfers_24h: 0 };

  describe('no row of mpt_issuances', () => {
    let h: Harness;
    let api: ApiClient;
    beforeAll(async () => {
      h = await startHarness({ env: NO_RATE_LIMIT });
      api = await h.api();
      await h.ch.insert(Table.Ledgers, [{ ...ledgerRow(head, headClose), parser_version: MPT_PARSER_VERSION }]);
      // a payment the job has not got to
      await h.ch.insert(Table.MptTransfers, [mptTransferRow(ids.htf, head, 0, 'payment', holders[0], holders[1], '1')]);
    }, 120_000);
    afterAll(async () => {
      await h?.close();
    });

    it('is the zero page at the newest committed ledger, the full envelope', async () => {
      const { body } = await api.ok('/v2/tokens?kind=mpt', 'tokens');
      expect(JSON.stringify(body)).toBe(
        JSON.stringify({
          result: 'success',
          coverage: { from_ledger_index: head, complete: false },
          kind: 'mpt',
          ledger_index: head,
          close_time: '2026-10-24T14:20:01Z',
          totals: ZERO,
          total: 0,
          count: 0,
          tokens: [],
        }),
      );
    });

    it('has total_below with min_holders', async () => {
      const { body } = await api.ok('/v2/tokens?kind=mpt&min_holders=2', 'tokens');
      expect([body.total, body.total_below, body.totals]).toEqual([0, 0, ZERO]);
    });
  });

  describe('no committed ledger', () => {
    let h: Harness;
    let api: ApiClient;
    beforeAll(async () => {
      h = await startHarness({ env: NO_RATE_LIMIT });
      api = await h.api();
    }, 120_000);
    afterAll(async () => {
      await h?.close();
    });

    it('is the answer of no generation', async () => {
      const { body } = await api.ok('/v2/tokens?kind=mpt', 'tokens');
      expect(body).toEqual({ result: 'success', coverage: { complete: false }, kind: 'mpt', count: 0, tokens: [] });
    });

    it('still checks the marker', async () => {
      const res = await api.get('/v2/tokens?kind=mpt&marker=%25%25');
      expect([res.status, res.body.message]).toEqual([400, 'invalid marker']);
    });
  });

  describe.each(['xahau', 'xahau-testnet'] as const)('on %s', (network) => {
    let h: Harness;
    let api: ApiClient;
    beforeAll(async () => {
      h = await startHarness({ network, env: NO_RATE_LIMIT });
      api = await h.api();
      // rows that a read would serve: no network without MPT has any
      await seedMptWorld(h);
    }, 120_000);
    afterAll(async () => {
      await h?.close();
    });

    it('answers kind=mpt on Xahau empty and complete', async () => {
      await expectNoMptRead(h, async () => {
        const { body } = await api.ok('/v2/tokens?kind=mpt', 'tokens');
        expect(JSON.stringify(body)).toBe(
          JSON.stringify({
            result: 'success',
            coverage: { from_ledger_index: 99_226_369, complete: true },
            kind: 'mpt',
            ledger_index: head,
            close_time: '2026-10-24T14:20:01Z',
            totals: ZERO,
            total: 0,
            count: 0,
            tokens: [],
          }),
        );
      });
    });
  });
});
