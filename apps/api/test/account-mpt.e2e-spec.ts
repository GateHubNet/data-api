import { mptIssuanceId, Table } from '@gatehub/data-api-shared';
import { COVERAGE_KEYS } from '../src/common/feature-coverage.service';
import { ACCOUNT_MPT_BODY_KEYS, ACCOUNT_MPT_KEYS } from '../src/mpt/mpt-objects';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt } from './support/amm';
import { csvDisposition } from './support/csv';
import { expectNoMptRead, MPT_WORLD, mptHolderStateRow, mptIssuanceRow, seedMptWorld } from './support/mpt-world';

/**
 * `GET /v2/accounts/{address}/mpt` (D9, spec 7.6) on a real ClickHouse, over the world of the MPT suites: `holders[0]` holds `htf`,
 * `unknownState`, `lockedAll`, `bare` emptied and `destroyed` deleted, each older state in another part, and a state of `htf` above the
 * head. The IDs sort as `htf`, `bare`, `unknownState`, `destroyed`, `lockedAll`, `escrow`.
 */

type Obj = Record<string, unknown>;

const { ids, issuer, holders, head } = MPT_WORLD;
const HOLDER = holders[0];
const COVERAGE = { from_ledger_index: 99_226_369, complete: true };
const path = (address: string): string => `/v2/accounts/${address}/mpt`;
const idsIn = (body: { mpt: Obj[] }): unknown[] => body.mpt.map((row) => row.mpt_issuance_id);

interface Page {
  marker?: string;
  mpt: Obj[];
}

describe('the MPT holdings of an account over the MPT world', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await seedMptWorld(h);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers the holdings at the head, in key order and by ID', async () => {
    const { body } = await api.ok(path(HOLDER), 'mpt');
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        result: 'success',
        coverage: COVERAGE,
        ledger_index: head,
        close_time: '2026-10-24T14:20:01Z',
        count: 3,
        mpt: [
          {
            mpt_issuance_id: ids.htf,
            issuer,
            ticker: 'HTF',
            name: 'Harborline Treasury Fund',
            asset_scale: 2,
            amount: '612040000',
            escrowed_amount: '0',
            locked: false,
            authorized: true,
          },
          {
            mpt_issuance_id: ids.unknownState,
            issuer,
            amount: '500',
            escrowed_amount: '0',
            locked: false,
            authorized: true,
          },
          {
            mpt_issuance_id: ids.lockedAll,
            issuer,
            asset_scale: 6,
            amount: '1000',
            escrowed_amount: '0',
            locked: true,
            authorized: true,
          },
        ],
      }),
    );
    expect(Object.keys(body)).toEqual(ACCOUNT_MPT_BODY_KEYS.filter((key) => key !== 'marker'));
    expect(Object.keys(body.coverage)).toEqual([...COVERAGE_KEYS]);
    for (const row of body.mpt) {
      const keys = Object.keys(row);
      expect(keys).toEqual(ACCOUNT_MPT_KEYS.filter((key) => keys.includes(key)));
    }
  });

  it('a holder of an issuance whose state is not known has no asset_scale and no ticker', async () => {
    const { body } = await api.ok(path(HOLDER), 'mpt');
    const unknown = body.mpt[1];
    expect(unknown.mpt_issuance_id).toBe(ids.unknownState);
    expect(unknown).not.toHaveProperty('asset_scale');
    expect(unknown).not.toHaveProperty('ticker');
    expect(unknown).not.toHaveProperty('name');
  });

  it('leaves out a balance its newest state emptied; include_zero=true has it', async () => {
    expect(idsIn((await api.ok(path(HOLDER), 'mpt')).body)).not.toContain(ids.bare);
    const { body } = await api.ok(`${path(HOLDER)}?include_zero=true`, 'mpt');
    expect(idsIn(body)).toEqual([ids.htf, ids.bare, ids.unknownState, ids.lockedAll]);
    expect(body.mpt[1]).toMatchObject({ amount: '0', escrowed_amount: '0', asset_scale: 0 });
  });

  it('leaves out a token its newest state deleted, with include_zero too', async () => {
    const { body } = await api.ok(`${path(HOLDER)}?include_zero=true`, 'mpt');
    expect(idsIn(body)).not.toContain(ids.destroyed);
  });

  it('does not read a state newer than the head', async () => {
    const { body } = await api.ok(path(HOLDER), 'mpt');
    // the state above the head holds 1
    expect(body.mpt[0].amount).toBe('612040000');
  });

  it('counts what is in escrow as a balance, and is locked by its own flag', async () => {
    const { body } = await api.ok(path(holders[1]), 'mpt');
    expect(body.mpt.map((row: Obj) => [row.mpt_issuance_id, row.amount, row.escrowed_amount, row.locked])).toEqual([
      [ids.htf, '124000000', '0', true],
      [ids.escrow, '0', '700', false],
    ]);
  });

  it('keeps the newest state of a transaction and of a node, and an amount above 2^53, digit for digit', async () => {
    const account = accountAt(0xd001);
    const id = ids.htf;
    await h.ch.insert(Table.MptHolderStates, [
      mptHolderStateRow(account, id, 107_000_001, '1', { tx_index: 1, node_index: 9 }),
      mptHolderStateRow(account, id, 107_000_001, '2', { tx_index: 2, node_index: 0 }),
      mptHolderStateRow(account, id, 107_000_001, '9007199254740993', { tx_index: 2, node_index: 1 }),
    ]);
    const { body } = await api.ok(path(account), 'mpt');
    expect(body.mpt.map((row: Obj) => row.amount)).toEqual(['9007199254740993']);
  });

  it('serves every amount as an integer string of at most 19 digits (ruling C25)', async () => {
    const { body } = await api.ok(`${path(HOLDER)}?include_zero=true`, 'mpt');
    const amounts = body.mpt.flatMap((row: Obj) => [row.amount, row.escrowed_amount]);
    expect(amounts).toHaveLength(8);
    for (const amount of amounts) expect(amount).toEqual(expect.stringMatching(/^\d{1,19}$/));
  });

  it('an account with nothing has an empty list', async () => {
    const { body } = await api.ok(path(accountAt(0xd0ff)), 'mpt');
    expect([body.count, body.mpt, body.ledger_index]).toEqual([0, [], head]);
    expect(body).not.toHaveProperty('marker');
  });

  it.each([1, 2])('pages with limit=%i into the unpaged list, the marker the last ID', async (limit) => {
    const unpaged = (await api.ok(`${path(HOLDER)}?include_zero=true`, 'mpt')).body.mpt;
    const pages = await api.pages<Page>(`${path(HOLDER)}?include_zero=true`, limit, 'mpt');
    expect(pages.flatMap((page) => page.mpt)).toEqual(unpaged);
    expect(pages[0].marker).toBe(pages[0].mpt[limit - 1].mpt_issuance_id);
    expect(pages[pages.length - 1].marker).toBeUndefined();
  });

  it('takes the marker in either case, and sets the Link of a next page', async () => {
    const res = await get(`${path(HOLDER)}?limit=1`);
    expect(res.body.marker).toBe(ids.htf);
    expect(res.headers.link).toContain(`marker=${ids.htf}`);
    const next = await api.ok(`${path(HOLDER)}?marker=${ids.htf.toLowerCase()}`, 'mpt');
    expect(idsIn(next.body)).toEqual([ids.unknownState, ids.lockedAll]);
    // the last page has none
    expect((await get(`${path(HOLDER)}?limit=3`)).headers.link).toBeUndefined();
  });

  it('checks the address, then the marker', async () => {
    const both = await get(`${path('rBad')}?marker=zz`);
    expect([both.status, both.body]).toEqual([400, { result: 'error', message: 'invalid ripple address' }]);
    const marker = await get(`${path(HOLDER)}?marker=zz`);
    expect([marker.status, marker.body]).toEqual([400, { result: 'error', message: 'invalid marker' }]);
    const short = await get(`${path(HOLDER)}?marker=${ids.htf.slice(0, 47)}`);
    expect(short.body.message).toBe('invalid marker');
  });

  it('format=csv is <address> - mpt.csv, the same columns whatever a row holds, without coverage', async () => {
    const res = await get(`${path(HOLDER)}?format=csv`);
    expect(res.headers['content-disposition']).toBe(csvDisposition(`${HOLDER} - mpt`));
    const rows = res.text.split('\n');
    expect(rows[0]).toBe(ACCOUNT_MPT_KEYS.map((key) => `"${key}"`).join(','));
    expect(rows).toHaveLength(4);
    expect(rows[2]).toBe(`"${ids.unknownState}","${issuer}","","","","500","0","false","true"`);
    expect(res.text).not.toContain('from_ledger_index');
  });

  it('format=csv keeps a name an issuer wrote from running in a spreadsheet, and the JSON serves it as written', async () => {
    const account = accountAt(0xd002);
    const id = mptIssuanceId(0x7001, issuer);
    const name = '=HYPERLINK("http://evil.example/","Fund")';
    await h.ch.insert(Table.MptIssuances, [mptIssuanceRow(id, { ticker: '@SUM', name })]);
    await h.ch.insert(Table.MptHolderStates, [mptHolderStateRow(account, id, 107_000_001, '5')]);

    const res = await get(`${path(account)}?format=csv`);
    expect(res.text.split('\n')[1]).toContain(`"'@SUM","'=HYPERLINK('http://evil.example/','Fund')"`);
    const { body } = await api.ok(path(account), 'mpt');
    expect(body.mpt[0]).toMatchObject({ ticker: '@SUM', name });
  });

  it('reads the issuance fields of the IDs of the page only', async () => {
    const spy = jest.spyOn(h.ch, 'query');
    await api.ok(`${path(HOLDER)}?limit=1`, 'mpt');
    const lookups = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.MptIssuances}`));
    expect(lookups).toHaveLength(1);
    expect(lookups[0][1]).toEqual({ ids: [ids.htf] });
  });

  it('answers 500 unable to retrieve mpt holdings when the database fails', async () => {
    jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('down'));
    const res = await get(path(HOLDER));
    expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve mpt holdings' }]);
  });
});

describe('the MPT holdings of an account with no committed ledger', () => {
  let h: Harness;
  let api: ApiClient;
  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT });
    api = await h.api();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('is an empty list, with no ledger to name', async () => {
    const { body } = await api.ok(path(HOLDER), 'mpt');
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({ result: 'success', coverage: { complete: false }, count: 0, mpt: [] }),
    );
  });
});

describe.each(['xahau', 'xahau-testnet'] as const)('the MPT holdings of an account on %s', (network) => {
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

  it('answers holdings on Xahau empty and complete', async () => {
    await expectNoMptRead(h, async () => {
      const { body } = await api.ok(path(HOLDER), 'mpt');
      expect(JSON.stringify(body)).toBe(
        JSON.stringify({
          result: 'success',
          coverage: COVERAGE,
          ledger_index: head,
          close_time: '2026-10-24T14:20:01Z',
          count: 0,
          mpt: [],
        }),
      );
    });
  });

  it('still checks the address and the marker', async () => {
    expect((await api.get(`${path('rBad')}`)).body.message).toBe('invalid ripple address');
    expect((await api.get(`${path(HOLDER)}?marker=zz`)).body.message).toBe('invalid marker');
  });
});
