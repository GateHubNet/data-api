import { Table } from '@gatehub/data-api-shared';
import {
  MPT_HOLDER_KEYS,
  MPT_HOLDERS_BODY_KEYS,
  MPT_TRANSFER_KEYS,
  MPT_TRANSFERS_BODY_KEYS,
} from '../src/mpt/mpt-objects';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { compare, primaryKeys, served } from './support/amm';
import { csvDisposition } from './support/csv';
import {
  BARE_HOLDERS,
  closeOfMpt,
  expectNoMptRead,
  HTF_HOLDERS,
  HTF_METADATA,
  MPT_TRANSFERS,
  MPT_WORLD,
  seedMptWorld,
} from './support/mpt-world';
import { explain } from './support/plans';
import { markerOf } from './support/read-rows';
import { ledgerRow } from './support/validators-seed';

/**
 * The MPT routes (D9, spec 7.2 to 7.5) on a real ClickHouse, over the rows of `support/mpt-world.ts` (read its header): an issuance,
 * the lookup of several, the holders and the transfers of one. The tables are seeded by hand; the ingest and the job that write them
 * have suites of their own.
 */

const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;
const { ids, issuer, holders, head } = MPT_WORLD;
const ENABLED = 99_226_369;
const COVERAGE = { from_ledger_index: ENABLED, complete: true };

/** `JSON.stringify` of an answer: the key order is part of what is compared. */
const text = (value: unknown): string => JSON.stringify(value);

type Obj = Record<string, unknown>;

/** `entry` has the keys of `order` it has, and in that order: none out of place, none made up. */
function expectKeysInOrder(entry: object, order: readonly string[]): void {
  const keys = Object.keys(entry);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

/** The address of each holder of a list, in the order served. */
const holdersIn = (body: { holders: { holder: string }[] }): string[] => body.holders.map((row) => row.holder);

/** A page of a holders' or a transfers' list. */
interface Page {
  marker?: string;
  holders: Obj[];
  transfers: Obj[];
}

/** The transfer a row of the world is served as: the keys in order, `source`, `destination` and `fee` only with a value. */
function transferOf(row: (typeof MPT_TRANSFERS)[number]): Obj {
  return {
    ledger_index: row.ledger_index,
    tx_index: row.tx_index,
    tx_hash: row.tx_hash,
    executed_time: `${new Date(row.close_time * 1000).toISOString().slice(0, 19)}Z`,
    tx_type: row.tx_type,
    kind: row.kind,
    ...(row.source !== '' && { source: row.source }),
    ...(row.destination !== '' && { destination: row.destination }),
    amount: row.amount,
    ...(row.fee !== '0' && { fee: row.fee }),
  };
}
/** The transfers of an issuance in the order of the list, without the row above the head. */
const transfersOf = (id: string): (typeof MPT_TRANSFERS)[number][] =>
  MPT_TRANSFERS.filter((row) => row.mpt_issuance_id === id && row.ledger_index <= head).sort(
    (a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index,
  );

describe('the MPT routes over the MPT world', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    get = api.get;
    await seedMptWorld(h);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('GET /v2/mpt/{issuanceId}', () => {
    it('answers the newest version of an issuance, whole and in key order', async () => {
      const res = await api.ok(`/v2/mpt/${ids.htf}`, 'issuance');
      const hex = Buffer.from(JSON.stringify(HTF_METADATA), 'utf8').toString('hex').toUpperCase();
      expect(text(res.body)).toBe(
        text({
          result: 'success',
          coverage: COVERAGE,
          issuance: {
            mpt_issuance_id: ids.htf,
            issuer,
            sequence: 298,
            ticker: 'HTF',
            name: 'Harborline Treasury Fund',
            asset_scale: 2,
            maximum_amount: '5000000000',
            outstanding_amount: '1820451120',
            escrowed_amount: '84411120',
            locked_amount: '124000000',
            locked_holders: 1,
            holders: 3,
            transfer_fee: 100,
            flags: {
              locked: false,
              can_lock: true,
              require_auth: true,
              can_escrow: false,
              can_trade: true,
              can_transfer: true,
              can_clawback: true,
            },
            metadata: HTF_METADATA,
            metadata_hex: hex,
            metadata_conforms: true,
            created_ledger: 99_412_004,
            created_time: '2025-10-09T11:20:31Z',
            created_tx_hash: (99_412_004).toString(16).toUpperCase().padStart(64, '0'),
            last_ledger: MPT_WORLD.head,
            destroyed: false,
          },
        }),
      );
      expect(res.headers['cache-control']).toBe('private, max-age=60');
    });

    it('takes the ID in lower case and answers it in upper case', async () => {
      const res = await api.ok(`/v2/mpt/${ids.htf.toLowerCase()}`, 'issuance');
      expect(res.body.issuance.mpt_issuance_id).toBe(ids.htf);
    });

    it('leaves out what an issuance does not have', async () => {
      const res = await api.ok(`/v2/mpt/${ids.bare}`, 'issuance');
      expect(Object.keys(res.body.issuance)).toEqual([
        'mpt_issuance_id',
        'issuer',
        'sequence',
        'asset_scale',
        'outstanding_amount',
        'escrowed_amount',
        'locked_amount',
        'locked_holders',
        'holders',
        'transfer_fee',
        'flags',
        'last_ledger',
        'destroyed',
      ]);
      // above 2^53, digit for digit
      expect(res.body.issuance.outstanding_amount).toBe('18014398509482023');
    });

    it('serves a destroyed issuance, with destroyed: true', async () => {
      const res = await api.ok(`/v2/mpt/${ids.destroyed}`, 'issuance');
      expect(res.body.issuance).toMatchObject({ mpt_issuance_id: ids.destroyed, destroyed: true, holders: 0 });
    });

    it('names the flags of a locked issuance', async () => {
      const res = await api.ok(`/v2/mpt/${ids.lockedAll}`, 'issuance');
      expect(res.body.issuance.flags).toMatchObject({ locked: true, can_lock: true, can_transfer: false });
      expect(res.body.issuance).toMatchObject({ locked_amount: '1300', locked_holders: 2, holders: 2 });
    });

    it('404s an issuance whose state is not known', async () => {
      const res = await get(`/v2/mpt/${ids.unknownState}`);
      expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'issuance not found' }]);
    });

    it('404s an issuance with no row', async () => {
      const res = await get(`/v2/mpt/${ids.nowhere}`);
      expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'issuance not found' }]);
    });

    it.each([
      ['47 digits', ids.htf.slice(0, 47)],
      ['49 digits', `${ids.htf}0`],
      ['0x…', `0x${ids.htf.slice(0, 46)}`],
      ['text', 'xyz'],
    ])('answers 400 invalid mpt issuance id for %s', async (_name, id) => {
      const res = await get(`/v2/mpt/${id}`);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid mpt issuance id' }]);
    });

    it('reads the issuance by its primary key', async () => {
      const { statements } = await served(h, api, Table.MptIssuances, `/v2/mpt/${ids.htf}`, 'issuance');
      expect(statements).toHaveLength(1);
      const [sql, params] = statements[0];
      const [primary] = primaryKeys(await explain(h, 'indexes = 1', sql, params));
      expect(primary.keys).toEqual(['mpt_issuance_id']);
      expect(primary.condition).toContain('mpt_issuance_id in');
    });

    it('answers 500 unable to retrieve issuance when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('down'));
      const res = await get(`/v2/mpt/${ids.htf}`);
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve issuance' }]);
    });
  });

  describe('the coverage', () => {
    const coverage = async (): Promise<unknown> => (await api.ok(`/v2/mpt/${ids.htf}`, 'issuance')).body.coverage;

    it('is complete only while no ledger at or above the enable ledger was written by an older parser', async () => {
      await api.ok('/v2/test-cache/clear', 'result');
      expect(await coverage()).toEqual(COVERAGE);

      const older = ENABLED + 31;
      await h.ch.insert(Table.Ledgers, [{ ...ledgerRow(older, closeOfMpt(ENABLED) + 124), parser_version: 9 }]);
      await api.ok('/v2/test-cache/clear', 'result');
      expect(await coverage()).toEqual({ from_ledger_index: older + 1, complete: false });

      // the reprocess of that ledger: its old row is deleted, and the new one is written by the new parser
      await h.ch.command(
        `ALTER TABLE ${Table.Ledgers} DELETE WHERE ledger_index = {older:UInt32}`,
        { older },
        {
          settings: { mutations_sync: '2' },
        },
      );
      await api.ok('/v2/test-cache/clear', 'result');
      expect(await coverage()).toEqual(COVERAGE);
    });
  });

  describe('GET /v2/mpt?ids=', () => {
    it('answers in request order, duplicates too, bare entries for what has no known state', async () => {
      const asked = [ids.nowhere, ids.htf, ids.unknownState, ids.bare.toLowerCase(), ids.htf, ids.destroyed];
      const res = await api.ok(`/v2/mpt?ids=${asked.join(',')}`, 'issuances');
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'issuances']);
      expect(res.body.count).toBe(6);
      expect(res.body.issuances.map((i: { mpt_issuance_id: string }) => i.mpt_issuance_id)).toEqual(
        asked.map((id) => id.toUpperCase()),
      );
      const [nowhere, htf, unknown, bare, again, destroyed] = res.body.issuances;
      expect(text(nowhere)).toBe(text({ mpt_issuance_id: ids.nowhere }));
      expect(text(unknown)).toBe(text({ mpt_issuance_id: ids.unknownState }));
      expect(text(htf)).toBe(
        text({
          mpt_issuance_id: ids.htf,
          issuer,
          ticker: 'HTF',
          name: 'Harborline Treasury Fund',
          asset_scale: 2,
          maximum_amount: '5000000000',
          outstanding_amount: '1820451120',
          holders: 3,
          transfer_fee: 100,
          flags: {
            locked: false,
            can_lock: true,
            require_auth: true,
            can_escrow: false,
            can_trade: true,
            can_transfer: true,
            can_clawback: true,
          },
          destroyed: false,
        }),
      );
      expect(text(again)).toBe(text(htf));
      expect(Object.keys(bare)).toEqual([
        'mpt_issuance_id',
        'issuer',
        'asset_scale',
        'outstanding_amount',
        'holders',
        'transfer_fee',
        'flags',
        'destroyed',
      ]);
      expect(destroyed).toMatchObject({ destroyed: true });
    });

    it.each([
      ['no ids', '', 'ids is required'],
      ['an empty ids', '?ids=', 'ids is required'],
      ['101 ids', `?ids=${Array(101).fill(ids.htf).join(',')}`, 'too many ids'],
      ['101 ids with a bad one', `?ids=${[...Array(100).fill(ids.htf), 'x'].join(',')}`, 'too many ids'],
      ['an empty element', `?ids=${ids.htf},,${ids.bare}`, 'invalid mpt issuance id'],
      ['47 digits', `?ids=${ids.htf.slice(0, 47)}`, 'invalid mpt issuance id'],
    ])('answers 400 for %s', async (_name, query, message) => {
      const res = await get(`/v2/mpt${query}`);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message }]);
    });

    it('answers 100 ids', async () => {
      const res = await api.ok(`/v2/mpt?ids=${Array(100).fill(ids.htf).join(',')}`, 'issuances');
      expect(res.body.count).toBe(100);
    });

    it('reads the issuances by their primary key', async () => {
      const path = `/v2/mpt?ids=${ids.htf},${ids.bare}`;
      const { statements } = await served(h, api, Table.MptIssuances, path, 'issuances');
      expect(statements).toHaveLength(1);
      const [sql, params] = statements[0];
      const [primary] = primaryKeys(await explain(h, 'indexes = 1', sql, params));
      expect(primary.keys).toEqual(['mpt_issuance_id']);
      expect(primary.condition).toContain('mpt_issuance_id in');
    });

    it('answers 500 unable to retrieve issuances when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('down'));
      const res = await get(`/v2/mpt?ids=${ids.htf}`);
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve issuances' }]);
    });
  });

  describe('GET /v2/mpt/{issuanceId}/holders', () => {
    const path = (id: string): string => `/v2/mpt/${id}/holders`;
    /** The list of `bare`, largest first: 2^53 + 1, 2^53, the two of 10 and the two of 9, each tie by address. */
    const bareOrder = [
      holders[3],
      holders[8],
      ...[holders[4], holders[5]].sort(compare),
      ...[holders[6], holders[7]].sort(compare),
    ];

    it('answers the holders in key order, with the newest version of each', async () => {
      const res = await api.ok(path(ids.htf), 'holders');
      expect(text(res.body)).toBe(
        text({
          result: 'success',
          coverage: COVERAGE,
          count: 3,
          holders: [
            {
              holder: HTF_HOLDERS[0][0],
              amount: '1000000000',
              escrowed_amount: '84411120',
              locked: false,
              authorized: true,
            },
            { holder: HTF_HOLDERS[1][0], amount: '612040000', escrowed_amount: '0', locked: false, authorized: true },
            { holder: HTF_HOLDERS[2][0], amount: '124000000', escrowed_amount: '0', locked: true, authorized: true },
          ],
        }),
      );
      expectKeysInOrder(res.body, MPT_HOLDERS_BODY_KEYS);
      for (const row of res.body.holders) expect(Object.keys(row)).toEqual([...MPT_HOLDER_KEYS]);
    });

    it('takes the ID in lower case', async () => {
      expect((await api.ok(path(ids.htf.toLowerCase()), 'holders')).body.count).toBe(3);
    });

    it('leaves out a deleted token, whatever its older version held', async () => {
      const res = await api.ok(path(ids.htf), 'holders');
      // holders[3] held 8888888888 in an older version; the token is gone
      expect(holdersIn(res.body)).not.toContain(holders[3]);
    });

    it('orders by the balance as a number (escrow included), digit for digit above 2^53, then by holder', async () => {
      const res = await api.ok(path(ids.bare), 'holders');
      expect(holdersIn(res.body)).toEqual(bareOrder);
      // 10 before 9, which text would turn around
      const amounts = Object.fromEntries(
        (res.body.holders as { holder: string; amount: string; escrowed_amount: string }[]).map((row) => [
          row.holder,
          [row.amount, row.escrowed_amount],
        ]),
      );
      expect(amounts[holders[3]]).toEqual(['9007199254740993', '0']);
      expect(amounts[holders[8]]).toEqual(['9007199254740992', '0']);
      expect(amounts[holders[5]]).toEqual(['4', '6']);
      expect(BARE_HOLDERS).toHaveLength(7);
    });

    it('include_zero adds the empty balances, after the rest', async () => {
      const res = await api.ok(`${path(ids.bare)}?include_zero=true`, 'holders');
      expect(holdersIn(res.body)).toEqual([...bareOrder, holders[0]]);
      expect(res.body.holders[6]).toMatchObject({ amount: '0', escrowed_amount: '0' });
      // `bool`: not any text
      expect((await api.ok(`${path(ids.bare)}?include_zero=1`, 'holders')).body.count).toBe(6);
    });

    it('counts a balance that is all in escrow', async () => {
      const res = await api.ok(path(ids.escrow), 'holders');
      expect(res.body.holders).toEqual([
        { holder: holders[1], amount: '0', escrowed_amount: '700', locked: false, authorized: false },
      ]);
    });

    it('is locked by its own flag or by the issuance', async () => {
      const own = await api.ok(path(ids.htf), 'holders');
      expect(own.body.holders.map((row: Obj) => row.locked)).toEqual([false, false, true]);
      const all = await api.ok(path(ids.lockedAll), 'holders');
      expect(all.body.holders.map((row: Obj) => [row.holder, row.locked, row.authorized])).toEqual([
        [holders[0], true, true],
        [holders[1], true, false],
      ]);
    });

    it.each([1, 2])('pages with limit=%i, across the balances above 2^53, into the unpaged list', async (limit) => {
      const unpaged = (await api.ok(`${path(ids.bare)}?include_zero=true`, 'holders')).body.holders;
      const pages = await api.pages<Page>(`${path(ids.bare)}?include_zero=true`, limit, 'holders');
      expect(pages.flatMap((page) => page.holders)).toEqual(unpaged);
      expect(pages).toHaveLength(Math.ceil(unpaged.length / limit));
      expect(pages[pages.length - 1].marker).toBeUndefined();
    });

    it('sets the Link of a next page, and none on the last', async () => {
      const first = await get(`${path(ids.htf)}?limit=2`);
      expect(first.body.marker).toBeDefined();
      expect(first.headers.link).toContain(`marker=${first.body.marker}`);
      expect(first.headers.link).toContain('rel="next"');
      const last = await get(`${path(ids.htf)}?limit=3`);
      expect(last.body).not.toHaveProperty('marker');
      expect(last.headers.link).toBeUndefined();
    });

    it('format=csv is <issuanceId> - holders.csv, its columns the keys of a holder, without coverage', async () => {
      const res = await get(`${path(ids.htf.toLowerCase())}?format=csv`);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${ids.htf} - holders`));
      const rows = res.text.split('\n');
      expect(rows[0]).toBe(MPT_HOLDER_KEYS.map((key) => `"${key}"`).join(','));
      expect(rows).toHaveLength(4);
      expect(rows[3]).toBe(`"${HTF_HOLDERS[2][0]}","124000000","0","true","true"`);
    });

    it('serves the holders and transfers of an issuance whose state is not known', async () => {
      const list = await api.ok(path(ids.unknownState), 'holders');
      expect(list.body.coverage).toEqual(COVERAGE);
      expect(holdersIn(list.body)).toEqual([holders[0], holders[9]]);
      const transfers = await api.ok(`/v2/mpt/${ids.unknownState}/transfers`, 'transfers');
      expect(transfers.body.transfers).toEqual(transfersOf(ids.unknownState).map(transferOf));
      expect(transfers.body.count).toBe(2);
    });

    it('404s an issuance with no row', async () => {
      const res = await get(path(ids.nowhere));
      expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'issuance not found' }]);
    });

    it('checks the ID, then the marker', async () => {
      const bad = await get(`/v2/mpt/xyz/holders?marker=!!!`);
      expect([bad.status, bad.body.message]).toEqual([400, 'invalid mpt issuance id']);
      // the marker comes before the read, so an issuance with no row is a 400 for it
      const marker = await get(`${path(ids.nowhere)}?marker=!!!`);
      expect([marker.status, marker.body.message]).toEqual([400, 'invalid marker']);
    });

    it.each([
      ['not base64', '!!!'],
      ['numbers', markerOf([5, holders[0]])],
      ['one value', markerOf(['5'])],
      ['not digits', markerOf(['5x', holders[0]])],
      ['20 digits', markerOf(['10000000000000000000', holders[0]])],
      ['above 2^63 - 1', markerOf(['9223372036854775808', holders[0]])],
    ])('answers 400 invalid marker for %s', async (_name, marker) => {
      const res = await get(`${path(ids.htf)}?marker=${marker}`);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid marker' }]);
    });

    it('takes a marker at the largest balance', async () => {
      const res = await api.ok(`${path(ids.htf)}?marker=${markerOf(['9223372036854775807', ''])}`, 'holders');
      expect(res.body.count).toBe(3);
    });

    it('answers 500 unable to retrieve holders when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('down'));
      const res = await get(path(ids.htf));
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve holders' }]);
    });
  });

  describe('GET /v2/mpt/{issuanceId}/transfers', () => {
    const path = (id: string): string => `/v2/mpt/${id}/transfers`;
    const htf = transfersOf(ids.htf);
    const KINDS = 'payment, clawback, lock, unlock, escrow_create, escrow_finish, escrow_cancel';

    it('answers the transfers of every kind in ledger order, each once, none above the head', async () => {
      const res = await api.ok(path(ids.htf), 'transfers');
      expect(htf.map((row) => row.kind)).toEqual(
        expect.arrayContaining([
          'payment',
          'clawback',
          'lock',
          'unlock',
          'escrow_create',
          'escrow_finish',
          'escrow_cancel',
        ]),
      );
      expect(htf).toHaveLength(13);
      expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'transfers']);
      expectKeysInOrder(res.body, MPT_TRANSFERS_BODY_KEYS);
      expect(res.body.coverage).toEqual(COVERAGE);
      expect(text(res.body.transfers)).toBe(text(htf.map(transferOf)));
      for (const row of res.body.transfers) expectKeysInOrder(row, MPT_TRANSFER_KEYS);
    });

    it('descending=true is newest first', async () => {
      const res = await api.ok(`${path(ids.htf)}?descending=true`, 'transfers');
      expect(res.body.transfers).toEqual([...htf].reverse().map(transferOf));
    });

    it('kind is a comma list, read in the capped read', async () => {
      const res = await api.ok(`${path(ids.htf)}?kind=lock,unlock`, 'transfers');
      expect(res.body.transfers).toEqual(htf.filter((row) => ['lock', 'unlock'].includes(row.kind)).map(transferOf));
      expect(res.body.count).toBe(3);
      // a page of a kind is a page of that kind, however many rows of others lie between its rows
      const pages = await api.pages<Page>(`${path(ids.htf)}?kind=payment`, 2, 'transfers');
      expect(pages.flatMap((page) => page.transfers)).toEqual(
        htf.filter((row) => row.kind === 'payment').map(transferOf),
      );
    });

    it.each(['mint', 'lock,mint', 'lock,', ',', 'LOCK'])('kind=%s is the kind message', async (kind) => {
      const res = await get(`${path(ids.htf)}?kind=${kind}`);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: `invalid kind - use: ${KINDS}` }]);
    });

    it('an empty kind is none', async () => {
      expect((await api.ok(`${path(ids.htf)}?kind=`, 'transfers')).body.count).toBe(htf.length);
    });

    it('account keeps the rows with it on either side, and is not validated', async () => {
      const res = await api.ok(`${path(ids.htf)}?account=${holders[2]}`, 'transfers');
      expect(res.body.transfers).toEqual(
        htf.filter((row) => row.source === holders[2] || row.destination === holders[2]).map(transferOf),
      );
      expect(res.body.transfers.some((row: Obj) => row.source === holders[2])).toBe(true);
      expect(res.body.transfers.some((row: Obj) => row.destination === holders[2])).toBe(true);
      expect((await api.ok(`${path(ids.htf)}?account=nobody`, 'transfers')).body.count).toBe(0);
    });

    it('start and end are the ledgers that closed in the window', async () => {
      const res = await api.ok(`${path(ids.htf)}?start=2026-09-03&end=2026-09-05T00:00:00Z`, 'transfers');
      expect(res.body.transfers).toEqual(
        htf.filter((row) => row.ledger_index >= 107_000_003 && row.ledger_index <= 107_000_005).map(transferOf),
      );
      const none = await api.ok(`${path(ids.htf)}?start=2030-01-01`, 'transfers');
      expect([none.body.count, none.body.transfers]).toEqual([0, []]);
      expect(none.body.coverage).toEqual(COVERAGE);
    });

    it('a lock of every balance has no destination', async () => {
      const res = await api.ok(path(ids.lockedAll), 'transfers');
      expect(res.body.transfers).toHaveLength(1);
      expect(res.body.transfers[0]).toMatchObject({ kind: 'lock', source: issuer, amount: '1300' });
      expect(res.body.transfers[0]).not.toHaveProperty('destination');
    });

    it('has a fee only above 0', async () => {
      const res = await api.ok(path(ids.htf), 'transfers');
      const fees = res.body.transfers.filter((row: Obj) => 'fee' in row).map((row: Obj) => row.fee);
      expect(fees).toEqual(['2500', '1']);
    });

    it.each([false, true])('pages across a ledger of two transfers, descending %s', async (descending) => {
      const pages = await api.pages<Page>(`${path(ids.htf)}?descending=${descending}`, 2, 'transfers');
      const expected = (descending ? [...htf].reverse() : htf).map(transferOf);
      expect(pages.flatMap((page) => page.transfers)).toEqual(expected);
    });

    it('format=csv is <issuanceId> - transfers.csv: the same columns on every page, an empty cell for what a row has not', async () => {
      const res = await get(`${path(ids.lockedAll.toLowerCase())}?format=csv`);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${ids.lockedAll} - transfers`));
      const [header, row] = res.text.split('\n');
      expect(header).toBe(MPT_TRANSFER_KEYS.map((key) => `"${key}"`).join(','));
      const cells = row.split(',');
      expect(cells[MPT_TRANSFER_KEYS.indexOf('destination')]).toBe('""');
      expect(cells[MPT_TRANSFER_KEYS.indexOf('fee')]).toBe('""');
      expect(cells[MPT_TRANSFER_KEYS.indexOf('kind')]).toBe('"lock"');
    });

    it('404s an issuance with no row', async () => {
      const res = await get(path(ids.nowhere));
      expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'issuance not found' }]);
    });

    it.each([
      ['/v2/mpt/xyz/transfers?start=bad', 'invalid mpt issuance id'],
      [`/v2/mpt/${ids.nowhere}/transfers?start=bad&end=bad&kind=mint&marker=!!!`, 'invalid start date format'],
      [`/v2/mpt/${ids.nowhere}/transfers?end=bad&kind=mint&marker=!!!`, 'invalid end date format'],
      [`/v2/mpt/${ids.nowhere}/transfers?kind=mint&marker=!!!`, `invalid kind - use: ${KINDS}`],
      [`/v2/mpt/${ids.nowhere}/transfers?marker=!!!`, 'invalid marker'],
    ])('checks in order: %s', async (url, message) => {
      const res = await get(url);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message }]);
    });

    it('answers 500 unable to retrieve transfers when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('down'));
      const res = await get(path(ids.htf));
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve transfers' }]);
    });
  });
});

describe.each(['xahau', 'xahau-testnet'] as const)('the MPT routes on %s', (network) => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network, env: NO_RATE_LIMIT });
    api = await h.api();
    // rows that a read would serve: no network without MPT has any, and a route that read the table would answer them
    await seedMptWorld(h);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('answers Xahau without reading an MPT table', async () => {
    await expectNoMptRead(h, async () => {
      const issuance = await api.get(`/v2/mpt/${ids.htf}`);
      expect([issuance.status, issuance.body]).toEqual([404, { result: 'error', message: 'issuance not found' }]);
      const lookup = await api.ok(`/v2/mpt?ids=${ids.htf},${ids.nowhere}`, 'issuances');
      expect(text(lookup.body)).toBe(
        text({
          result: 'success',
          count: 2,
          issuances: [{ mpt_issuance_id: ids.htf }, { mpt_issuance_id: ids.nowhere }],
        }),
      );
    });
  });

  it.each(['holders', 'transfers'])('answers /%s of an issuance 404, without reading an MPT table', async (list) => {
    await expectNoMptRead(h, async () => {
      const res = await api.get(`/v2/mpt/${ids.htf}/${list}`);
      expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'issuance not found' }]);
    });
  });
});
