import { Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { primaryKeys, served } from './support/amm';
import { closeOfMpt, expectNoMptRead, HTF_METADATA, MPT_WORLD, seedMptWorld } from './support/mpt-world';
import { explain } from './support/plans';
import { ledgerRow } from './support/validators-seed';

/**
 * The MPT routes (D9, spec 7.2 to 7.5) on a real ClickHouse, over the rows of `support/mpt-world.ts` (read its header): an issuance,
 * the lookup of several, the holders and the transfers of one. The tables are seeded by hand; the ingest and the job that write them
 * have suites of their own.
 */

const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;
const { ids, issuer } = MPT_WORLD;
const ENABLED = 99_226_369;
const COVERAGE = { from_ledger_index: ENABLED, complete: true };

/** `JSON.stringify` of an answer: the key order is part of what is compared. */
const text = (value: unknown): string => JSON.stringify(value);

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
      expect(res.body.issuance.outstanding_amount).toBe('9007199254741031');
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
});
