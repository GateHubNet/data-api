import { amendmentId, NFT_PARSER_VERSION, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, cells, decodeMarker, iso, lines } from './support/amm';
import { csvDisposition } from './support/csv';
import { fixtureSource } from './support/fixtures';
import {
  collectionOf,
  collectionsOf,
  dayOf,
  daysOf,
  Facts,
  holdersOfCollection,
  idOfKey,
  Key,
  nftsOfCollection,
  owner,
  rateRows,
  ratesOf,
  saleOf,
  salesOfCollection,
  sortedCollections,
  syntheticCollections,
  USD_ISSUER,
} from './support/nft-collections-oracle';
import { buildNftAggregates, fixtureNftEvents, insertNftEvents, nftEventRow } from './support/nfts';
import {
  ABOVE,
  compareKeys,
  Ev,
  expectOrdered,
  FULL,
  Obj,
  Slot,
  syntheticEvents,
  synthId,
  TWICE,
  WORLDS,
} from './support/nfts-oracle';
import { insertState, ledgerRow } from './support/validators-seed';

/**
 * `GET /v2/nft_collections`, `/{issuer}[/{taxon}]` and its `/nfts`, `/holders`, `/sales` and `/stats` on a real ClickHouse, for each
 * network: the recorded ledgers of the NFT fixtures with the aggregates built over them, the NFTs of the NFT suite and eight
 * collections made by hand (their transactions say `synthetic-…`) for what the recordings do not hold: ties in every sort, a
 * collection of burned NFTs, a holder who gives up all it held, sales priced in an issued currency with a rate and without, a sale
 * written twice. The aggregates are built twice, the second time over events that change the first rows (a burn, a sale, a
 * transfer), so that every table has older and newer versions of its rows and the routes have to read the newest.
 *
 * What the routes answer is checked against an oracle in plain JavaScript over the events (`support/nft-collections-oracle.ts`):
 * the facts of a collection, its NFTs, holders, sales and days, none of it from the code under test.
 */

/** The pinned key orders (written out here once more, apart from the code under test). */
const COLLECTION_KEYS = [
  'issuer',
  'taxon',
  'kind',
  'supply',
  'holders',
  'minted',
  'burned',
  'sales_count',
  'volume_native',
  'first_mint',
  'last_mint',
  'last_ledger',
];
const POINT_KEYS = ['ledger_index', 'tx_hash', 'executed_time'];
const DAY_KEYS = ['date', 'sales_count', 'volume_native', 'avg_price_native', 'min_price_native', 'mints', 'burns'];
const SALE_KEYS = [
  'nft_id',
  'kind',
  'issuer',
  'taxon',
  'serial',
  'ledger_index',
  'tx_index',
  'event_index',
  'tx_hash',
  'executed_time',
  'seller',
  'buyer',
  'mode',
  'amount',
  'currency',
  'amount_issuer',
  'converted_amount',
  'broker',
  'broker_fee',
  'royalty_est',
];
const NFT_KEYS = [
  'nft_id',
  'kind',
  'issuer',
  'taxon',
  'serial',
  'flags',
  'transfer_fee',
  'owner',
  'owner_since',
  'uri',
  'digest',
  'minted',
  'burned',
  'burned_at',
  'sale_count',
  'last_sale',
];

/** The key of a collection in a path, as the first mistake of a request is reported. */
const BAD_MARKER = '!!!';
const base64 = (values: unknown[]): string => Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');

describe.each(WORLDS)('the NFT collection routes over the recorded $seed ledgers', (world) => {
  const xrpl = world.kind === 'nftoken';
  const recorded = fixtureNftEvents(world.seed);
  const slots: Slot[] = fixtureSource(world.seed)
    .list()
    .map((l) => ({ index: l.header.ledger_index, close: l.header.close_time }))
    .sort((a, b) => a.index - b.index);
  const FIRST = slots[0].index;
  const HEAD = slots[slots.length - 1].index;
  const made = syntheticEvents(world, slots, HEAD);
  const hand = syntheticCollections(world, slots);
  const rates = ratesOf(hand.rates);

  /** The events of every NFT in the order of the index, up to the head: what the routes can see. */
  const byNft = new Map<string, Ev[]>();
  for (const e of [...recorded, ...made.rows, ...hand.first, ...hand.second].sort(compareKeys)) {
    const list = byNft.get(e.nft_id);
    if (list) list.push(e);
    else byNft.set(e.nft_id, [e]);
  }
  const facts = collectionsOf(byNft);
  const factsOf = (key: Key): Facts => facts.get(idOfKey(key)) as Facts;
  /** Every collection as the API serves it, and by sort. */
  const objects = [...facts.values()].map((f) => collectionOf(f, rates));
  const objectOf = (key: Key): Obj => collectionOf(factsOf(key), rates);
  const [c0, c1, c2, c3, c4, c5, c6, c7] = hand.keys;
  /** The collection of the NFT suite's NFTs (FULL, TWICE, BUSY, ...), made by hand there. */
  const NFT_SUITE: Key = { issuer: (made.rows.find((e) => e.nft_id === FULL) as Ev).issuer, taxon_key: xrpl ? 7 : 0 };
  const WRITTEN_TWICE = c3;

  const pathOf = (key: Key, tail = ''): string =>
    xrpl ? `/v2/nft_collections/${key.issuer}/${key.taxon_key}${tail}` : `/v2/nft_collections/${key.issuer}${tail}`;
  /** The other network's form of the path of a collection. */
  const otherFormOf = (key: Key, tail = ''): string =>
    xrpl ? `/v2/nft_collections/${key.issuer}${tail}` : `/v2/nft_collections/${key.issuer}/${key.taxon_key}${tail}`;
  const fileOf = (key: Key, list: string): string => `${key.issuer}${xrpl ? ` ${key.taxon_key}` : ''} - ${list}`;
  /** A window of the whole seed: the second of the first ledger to the second of the newest. */
  const WINDOW = `start=${iso(slots[0].close)}&end=${iso(slots[slots.length - 1].close)}`;

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  /** Asserts that walking `path` with each limit gives `want` in whole, every page but the last full and the last with no marker. */
  async function expectWalk(path: string, key: string, want: unknown[], limits = [1, 2, 3, 7]): Promise<void> {
    for (const limit of limits) {
      const walked = await api.pages<{ count: number; marker?: string } & Record<string, unknown[]>>(path, limit, key);
      expect([path, limit, walked.flatMap((p) => p[key])]).toEqual([path, limit, want]);
      walked.forEach((page, i) => {
        expect(page.count).toBe(page[key].length);
        if (i < walked.length - 1) expect(page[key]).toHaveLength(limit);
        else expect(page.marker).toBeUndefined();
      });
    }
  }

  beforeAll(async () => {
    h = await startHarness({
      seed: world.seed,
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    api = await h.api();
    get = api.get;
    // the rates the sales are priced with, there before the aggregates are built: the volume of a collection is worked out with
    // the rates known when it is computed, and /stats converts at read time, so both have to see the same
    await h.ch.insert(Table.NativeRatesDaily, rateRows(hand.rates));
    await insertNftEvents(h, made.rows);
    // a row above the committed head: the ledger is not committed, so none of the routes may serve it
    await insertNftEvents(h, made.above);
    await insertNftEvents(h, hand.first);
    // TWICE of the NFT suite, and the collection WRITTEN_TWICE, are written twice, as a re-ingest can leave them, each time as a
    // part of its own
    for (const table of [Table.NftEvents, Table.CollectionNftEvents, Table.NftSales]) {
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
    }
    for (const table of [Table.NftEvents, Table.CollectionNftEvents]) {
      await h.ch.command(
        `INSERT INTO ${table} SELECT * FROM ${table} WHERE nft_id = {id:String}`,
        { id: TWICE },
        { settings: { insert_deduplicate: 0 } },
      );
    }
    for (const table of [Table.NftEvents, Table.CollectionNftEvents, Table.NftSales]) {
      await h.ch.command(
        `INSERT INTO ${table} SELECT * FROM ${table} WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32}`,
        { issuer: WRITTEN_TWICE.issuer, taxon_key: WRITTEN_TWICE.taxon_key },
        { settings: { insert_deduplicate: 0 } },
      );
    }
    await buildNftAggregates(h, world.native);
    // then the events that change the rows the first build wrote, and the build again over what changed
    await insertNftEvents(h, hand.second);
    await buildNftAggregates(h, world.native);
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume', async () => {
    expect(slots.length).toBeGreaterThanOrEqual(5);
    expect(hand.keys).toHaveLength(8);
    // collections with the same figures, so that every sort has ties to break
    for (const sort of ['volume', 'supply', 'holders'] as const) {
      const values = objects.map((o) => (sort === 'volume' ? Number(o.volume_native) : (o[sort] as number)));
      expect([sort, new Set(values).size < values.length]).toEqual([sort, true]);
    }
    expect(objects.length).toBeGreaterThan(hand.keys.length);
    // the ties among the collections made by hand
    expect([objectOf(c0).supply, objectOf(c1).supply]).toEqual([3, 3]);
    expect([objectOf(c0).volume_native, objectOf(c1).volume_native]).toEqual(['100', '100']);
    expect([objectOf(c1).holders, objectOf(c2).holders]).toEqual([3, 3]);
    expect([objectOf(c4).holders, objectOf(c6).holders]).toEqual([2, 2]);
    // the aggregates have older and newer versions of the rows that the second build changed
    const nftOfC4 = synthId(0x100000 + 4 * 100 + 4);
    const versions = await h.ch.query<{ n: string; burned: string }>(
      `SELECT count() AS n, max(burned) AS burned FROM ${Table.Nfts} WHERE nft_id = {id:String}`,
      { id: nftOfC4 },
    );
    expect([Number(versions[0].n), Number(versions[0].burned)]).toEqual([2, 1]);
    const [gone] = await h.ch.query<{ held: string }>(
      `SELECT held FROM ${Table.NftCollectionHolders} WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32} AND owner = {owner:String}
        ORDER BY version DESC LIMIT 1`,
      { ...c0, owner: owner(1) },
    );
    expect(Number(gone.held)).toBe(0);
    const [older] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.NftCollectionHolders} WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32} AND owner = {owner:String}`,
      { ...c0, owner: owner(1) },
    );
    expect(Number(older.n)).toBe(2);
  });

  // -- the list ---------------------------------------------------------------------------------------------------------

  describe('GET /v2/nft_collections', () => {
    it('lists the collections by volume descending, keys in COLLECTION_KEYS order, with total', async () => {
      const res = await get('/v2/nft_collections?limit=1000');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'total', 'count', 'collections']);
      expect(res.body.result).toBe('success');
      expect(res.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
      expect(Object.keys(res.body.coverage)).toEqual(['from_ledger_index', 'complete']);
      expect(res.body.total).toBe(objects.length);
      expect(res.body.count).toBe(objects.length);
      expect(res.body.collections).toEqual(sortedCollections(objects, 'volume', true));
      for (const collection of res.body.collections as Obj[]) {
        expectOrdered(collection, COLLECTION_KEYS, collection.issuer);
      }
      // the same without the sort, and with the sort named as it is
      expect((await get('/v2/nft_collections?limit=1000&sort=volume&descending=true')).body.collections).toEqual(
        res.body.collections,
      );
      // the biggest first: the collection with the most volume heads the list, and the volume is exact text
      const first = res.body.collections[0] as Obj;
      expect(Number(first.volume_native)).toBeGreaterThanOrEqual(Number(objectOf(c3).volume_native));
      expect(typeof first.volume_native).toBe('string');
    });

    it('the fields of a collection made by hand: counts, the volume of the sales that have a price, and the mints', async () => {
      const list = (await get('/v2/nft_collections?limit=1000')).body.collections as Obj[];
      const served = (key: Key): Obj =>
        list.find((c) => c.issuer === key.issuer && (c.taxon ?? 0) === (xrpl ? key.taxon_key : 0)) as Obj;
      // c3: three sales, one of them in JPY with no rate: counted and not priced (250.5 and the brokered 3)
      expect(served(c3)).toMatchObject({
        supply: 1,
        holders: 1,
        minted: 1,
        burned: 0,
        sales_count: 3,
        volume_native: '253.5',
      });
      // c4: 40 USD at a rate of 4 is 10 coins; then one of its five NFTs was burned
      expect(served(c4)).toMatchObject({
        supply: 4,
        holders: 2,
        minted: 5,
        burned: 1,
        sales_count: 1,
        volume_native: '10',
      });
      // c0: its holder P1 gave up everything in the second batch: one holder
      expect(served(c0)).toMatchObject({
        supply: 3,
        holders: 1,
        minted: 3,
        burned: 0,
        sales_count: 1,
        volume_native: '100',
      });
      // c7: both NFTs burned: it is a collection with no supply and no holder
      expect(served(c7)).toMatchObject({
        supply: 0,
        holders: 0,
        minted: 2,
        burned: 2,
        sales_count: 0,
        volume_native: '0',
      });
      for (const key of hand.keys) {
        expect([idOfKey(key), served(key)]).toEqual([idOfKey(key), objectOf(key)]);
      }
      // the first and last mint are the events of the collection, with the time as text
      const mints = factsOf(c2).events.filter((e) => e.event === 'mint');
      expect(served(c2).first_mint).toEqual({
        ledger_index: mints[0].ledger_index,
        tx_hash: mints[0].tx_hash,
        executed_time: iso(mints[0].close_time),
      });
      expect(Object.keys(served(c2).first_mint as Obj)).toEqual(POINT_KEYS);
      expect(served(c2).taxon === undefined).toBe(!xrpl);
    });

    it('sorts by supply and holders, both ways, ties by issuer and taxon; markers concatenate', async () => {
      for (const sort of ['volume', 'supply', 'holders'] as const) {
        for (const descending of [true, false]) {
          const want = sortedCollections(objects, sort, descending);
          const path = `/v2/nft_collections?sort=${sort}&descending=${descending}`;
          const res = await get(`${path}&limit=1000`);
          expect([path, res.status]).toEqual([path, 200]);
          expect([path, res.body.collections]).toEqual([path, want]);
          // the walk by pages of 1, 2, 3 and 7 gives the same list
          await expectWalk(path, 'collections', want);
          // the marker holds the value, the issuer and the taxon of the last collection of the page
          const page = await get(`${path}&limit=2`);
          const last = want[1];
          const value = sort === 'volume' ? Number(last.volume_native) : (last[sort] as number);
          expect(decodeMarker(page.body.marker)).toEqual([value, last.issuer, xrpl ? last.taxon : 0]);
          expect(Object.keys(page.body)).toEqual(['result', 'coverage', 'total', 'count', 'marker', 'collections']);
          expect(page.body.total).toBe(objects.length);
        }
      }
      // ties: the collections of one figure go by issuer and then taxon, ascending, whichever way the sort runs
      const bySupply = (await get('/v2/nft_collections?sort=supply&limit=1000')).body.collections as Obj[];
      const tied = bySupply.filter((c) => c.supply === 3 && hand.keys.some((k) => k.issuer === c.issuer));
      expect(
        tied.map((c) => idOfKey({ issuer: c.issuer as string, taxon_key: (c.taxon as number | undefined) ?? 0 })),
      ).toEqual([c0, c1].map(idOfKey).sort());
    });

    it('descending=false is the smallest first, and anything but false keeps the biggest first', async () => {
      const smallest = await get('/v2/nft_collections?sort=supply&descending=false&limit=1000');
      const biggest = await get('/v2/nft_collections?sort=supply&limit=1000');
      expect(smallest.body.collections).toEqual(sortedCollections(objects, 'supply', false));
      expect((smallest.body.collections as Obj[])[0].supply).toBe(0);
      for (const descending of ['', 'true', '1', 'yes', 'nope']) {
        const res = await get(`/v2/nft_collections?sort=supply&descending=${descending}&limit=1000`);
        expect([descending, res.body.collections]).toEqual([descending, biggest.body.collections]);
      }
      for (const descending of ['false', 'FALSE', 'False']) {
        const res = await get(`/v2/nft_collections?sort=supply&descending=${descending}&limit=1000`);
        expect([descending, res.body.collections]).toEqual([descending, smallest.body.collections]);
      }
      // an empty sort is the volume
      expect((await get('/v2/nft_collections?sort=&limit=1000')).body.collections).toEqual(
        sortedCollections(objects, 'volume', true),
      );
    });

    it('filters by issuer, and total counts what the filter matches', async () => {
      const issuers = [...new Set(objects.map((o) => o.issuer as string))];
      expect(issuers.length).toBeGreaterThan(3);
      for (const issuer of issuers) {
        const want = sortedCollections(
          objects.filter((o) => o.issuer === issuer),
          'volume',
          true,
        );
        const res = await get(`/v2/nft_collections?issuer=${issuer}`);
        expect([issuer, res.status]).toEqual([issuer, 200]);
        expect([issuer, res.body.collections]).toEqual([issuer, want]);
        expect([issuer, res.body.total, res.body.count]).toEqual([issuer, want.length, want.length]);
      }
      if (xrpl) {
        // three taxons of one issuer, and a walk with a filter pages the filtered list, with the total of the filter
        const mine = sortedCollections(
          objects.filter((o) => o.issuer === c0.issuer),
          'supply',
          false,
        );
        expect(mine).toHaveLength(3);
        const walked = await api.pages<{ total: number; collections: Obj[]; marker?: string }>(
          `/v2/nft_collections?issuer=${c0.issuer}&sort=supply&descending=false`,
          2,
          'collections',
        );
        expect(walked.flatMap((p) => p.collections)).toEqual(mine);
        expect(walked.map((p) => p.total)).toEqual([3, 3]);
      }
      // an issuer with no collection is an empty list; an empty issuer is no filter
      const none = await get(`/v2/nft_collections?issuer=${accountAt(0x9999)}`);
      expect([none.status, none.body.total, none.body.count, none.body.collections]).toEqual([200, 0, 0, []]);
      expect((await get('/v2/nft_collections?issuer=&limit=1000')).body.total).toBe(objects.length);
    });

    it('the rows of every collection are kept 60 s, those of one issuer are read each time and kept under no key of their own', async () => {
      const reads = (): number =>
        (h.ch.query as unknown as jest.SpyInstance).mock.calls.filter(([sql]) =>
          String(sql).includes(`FROM ${Table.NftCollections}`),
        ).length;
      await api.ok('/v2/test-cache/clear', 'result');
      const spy = jest.spyOn(h.ch, 'query');
      await api.ok('/v2/nft_collections?sort=supply', 'collections');
      await api.ok('/v2/nft_collections?sort=holders&descending=false', 'collections');
      await api.ok('/v2/nft_collections?limit=1', 'collections');
      // one read for three requests of three sorts and pages: the sort and the page are made per request
      expect(reads()).toBe(1);
      spy.mockClear();
      for (const issuer of [c0.issuer, c0.issuer, c1.issuer, accountAt(0x1234)]) {
        await api.ok(`/v2/nft_collections?issuer=${issuer}`, 'collections');
      }
      // each of them read the rows of the issuer; the list of every collection, kept by the requests above, was not asked for
      expect(reads()).toBe(4);
      expect(spy.mock.calls.some(([sql]) => String(sql).includes('WHERE issuer = {issuer:String}'))).toBe(true);
    });

    it('answers 400 invalid issuer address, then invalid sort, then invalid marker', async () => {
      const answer = async (path: string): Promise<[number, string]> => {
        const res = await get(path);
        return [res.status, res.body.message];
      };
      expect(await answer(`/v2/nft_collections?issuer=xyz&sort=nope&marker=${BAD_MARKER}`)).toEqual([
        400,
        'invalid issuer address',
      ]);
      expect(await answer(`/v2/nft_collections?sort=nope&marker=${BAD_MARKER}`)).toEqual([400, 'invalid sort']);
      expect(await answer(`/v2/nft_collections?marker=${BAD_MARKER}`)).toEqual([400, 'invalid marker']);
      for (const sort of ['sales', 'Volume', 'volume,supply', 'supply ']) {
        expect(await answer(`/v2/nft_collections?sort=${encodeURIComponent(sort)}`)).toEqual([400, 'invalid sort']);
      }
      // a marker of the list is a number, an issuer and a taxon: for the volume any number, for the counts a whole one
      for (const [sort, marker] of [
        ['volume', base64([])],
        ['volume', base64([1, 'rX'])],
        ['volume', base64(['1', 'rX', 1])],
        ['volume', base64([1, 2, 1])],
        ['volume', base64([1, 'rX', -1])],
        ['volume', base64([null, 'rX', 1])],
        ['supply', base64([-1, 'rX', 1])],
        ['supply', base64([1.5, 'rX', 1])],
        ['holders', base64([1, 'rX', 2 ** 32])],
        ['holders', base64([1, 'rX', 1, 4])],
        ['holders', 'not base64 !'],
      ] as const) {
        expect([
          sort,
          marker,
          await answer(`/v2/nft_collections?sort=${sort}&marker=${encodeURIComponent(marker)}`),
        ]).toEqual([sort, marker, [400, 'invalid marker']]);
      }
    });
  });

  // -- one collection ---------------------------------------------------------------------------------------------------

  describe('GET /v2/nft_collections/{issuer}[/{taxon}]', () => {
    it('answers a collection by issuer/taxon on XRPL and by issuer on Xahau; the other form is 404 collection not found', async () => {
      for (const f of facts.values()) {
        const res = await get(pathOf(f.key));
        expect([idOfKey(f.key), res.status]).toEqual([idOfKey(f.key), 200]);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'collection']);
        expect([idOfKey(f.key), res.body.collection]).toEqual([idOfKey(f.key), collectionOf(f, rates)]);
        expectOrdered(res.body.collection, COLLECTION_KEYS, idOfKey(f.key));
        expect(res.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
        const other = await get(otherFormOf(f.key));
        expect([idOfKey(f.key), other.status, other.body]).toEqual([
          idOfKey(f.key),
          404,
          { result: 'error', message: 'collection not found' },
        ]);
      }
      // a collection that does not exist, with a good issuer and taxon
      const none = await get(pathOf({ issuer: accountAt(0x9998), taxon_key: xrpl ? 9 : 0 }));
      expect([none.status, none.body]).toEqual([404, { result: 'error', message: 'collection not found' }]);
      // a taxon the issuer has none of
      if (xrpl) {
        const nobody = await get(pathOf({ issuer: c0.issuer, taxon_key: 4 }));
        expect([nobody.status, nobody.body.message]).toEqual([404, 'collection not found']);
      }
    });

    it('checks the issuer and the taxon: 400 invalid issuer address, and on XRPL invalid taxon', async () => {
      const answer = async (path: string): Promise<[number, string]> => {
        const res = await get(path);
        return [res.status, res.body.message];
      };
      expect(await answer(otherFormOf({ issuer: 'xyz', taxon_key: 1 }))).toEqual([400, 'invalid issuer address']);
      expect(await answer(pathOf({ issuer: 'xyz', taxon_key: 1 }))).toEqual([400, 'invalid issuer address']);
      expect(await answer(`/v2/nft_collections/${c0.issuer}/nope`)).toEqual(
        xrpl ? [400, 'invalid taxon'] : [404, 'collection not found'],
      );
      if (xrpl) {
        for (const taxon of ['-1', '1.5', '4294967296', '0x1', '']) {
          expect([taxon, await answer(`/v2/nft_collections/${c0.issuer}/${taxon}`)]).toEqual([
            taxon,
            taxon === '' ? [404, 'collection not found'] : [400, 'invalid taxon'],
          ]);
        }
        // a taxon is a decimal number: 01 is the taxon 1
        expect((await get(`/v2/nft_collections/${c0.issuer}/01`)).body.collection).toEqual(objectOf(c0));
      }
    });

    it('/v2/nft_collections/{issuer}/nfts on XRPL is 404 collection not found, not a taxon', async () => {
      const issuer = c0.issuer;
      for (const tail of ['nfts', 'holders', 'sales', 'stats']) {
        const query = tail === 'stats' ? `?${WINDOW}` : '';
        const res = await get(`/v2/nft_collections/${issuer}/${tail}${query}`);
        // (on Xahau this is the form of the collection: it is served)
        if (xrpl) {
          expect([tail, res.status, res.body]).toEqual([
            tail,
            404,
            { result: 'error', message: 'collection not found' },
          ]);
        } else {
          expect([tail, res.status]).toEqual([tail, 200]);
        }
      }
      if (!xrpl) {
        // and a taxon in the path is the other form on Xahau, whatever list it asks for
        for (const tail of ['nfts', 'holders', 'sales', 'stats']) {
          const res = await get(`/v2/nft_collections/${issuer}/7/${tail}?${WINDOW}`);
          expect([tail, res.status, res.body.message]).toEqual([tail, 404, 'collection not found']);
        }
      }
    });
  });

  // -- the NFTs ----------------------------------------------------------------------------------------------------------

  describe('GET …/nfts', () => {
    it('nfts: by serial, burned left out unless include_burned, owner reads the holdings', async () => {
      for (const f of facts.values()) {
        const id = idOfKey(f.key);
        const res = await get(`${pathOf(f.key, '/nfts')}?limit=1000`);
        expect([id, res.status]).toEqual([id, 200]);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'nfts']);
        expect([id, res.body.nfts]).toEqual([id, nftsOfCollection(f)]);
        expect(res.body.count).toBe(res.body.nfts.length);
        expect(res.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
        for (const nft of res.body.nfts as Obj[]) expectOrdered(nft, NFT_KEYS, nft.nft_id);
        // with the burned ones
        const all = await get(`${pathOf(f.key, '/nfts')}?limit=1000&include_burned=true`);
        expect([id, all.body.nfts]).toEqual([id, nftsOfCollection(f, true)]);
      }
      // by serial on XRPL and by id on Xahau: c2's serials are scrambled against its ids
      const c2nfts = (await get(`${pathOf(c2, '/nfts')}`)).body.nfts as Obj[];
      expect(c2nfts).toHaveLength(5);
      const ids = c2nfts.map((n) => n.nft_id as string);
      if (xrpl) {
        const serials = c2nfts.map((n) => n.serial as number);
        expect(serials).toEqual([...serials].sort((a, b) => a - b));
        expect(ids).not.toEqual([...ids].sort());
      } else {
        expect(ids).toEqual([...ids].sort());
      }
    });

    it('an NFT burned after its row was written is not served though an older version of its row says it is not', async () => {
      const burned = synthId(0x100000 + 4 * 100 + 4);
      const rows = await h.ch.query<{ burned: string }>(
        `SELECT burned FROM ${Table.Nfts} WHERE nft_id = {id:String} ORDER BY version`,
        { id: burned },
      );
      expect(rows.map((r) => Number(r.burned))).toEqual([0, 1]);
      const served = (await get(`${pathOf(c4, '/nfts')}`)).body.nfts as Obj[];
      expect(served.map((n) => n.nft_id)).not.toContain(burned);
      expect(served).toHaveLength(4);
      const withBurned = (await get(`${pathOf(c4, '/nfts')}?include_burned=true`)).body.nfts as Obj[];
      const nft = withBurned.find((n) => n.nft_id === burned) as Obj;
      expect(nft.burned).toBe(true);
      expect(nft).not.toHaveProperty('owner');
      expect(Object.keys(nft.burned_at as Obj)).toEqual([...POINT_KEYS, 'by']);
      // a collection whose NFTs are all burned lists none, until they are asked for
      expect((await get(pathOf(c7, '/nfts'))).body).toMatchObject({ count: 0, nfts: [] });
      expect((await get(`${pathOf(c7, '/nfts')}?include_burned=true`)).body.count).toBe(2);
      // include_burned is true for any text with `true` in it, false otherwise
      for (const flag of ['false', '1', '']) {
        expect((await get(`${pathOf(c7, '/nfts')}?include_burned=${flag}`)).body.count).toBe(0);
      }
    });

    it('owner reads the holdings: the NFTs the account holds now, not those it held before', async () => {
      const holders = new Set<string>();
      for (const f of facts.values()) for (const h of holdersOfCollection(f)) holders.add(h.owner);
      expect(holders.size).toBeGreaterThan(5);
      for (const f of [c0, c1, c2, c4, c5, c6, NFT_SUITE].map(factsOf)) {
        const accounts = [
          ...new Set([owner(1), owner(2), owner(3), owner(4), owner(5), ...holdersOfCollection(f).map((h) => h.owner)]),
        ];
        for (const account of accounts) {
          const res = await get(`${pathOf(f.key, '/nfts')}?owner=${account}&limit=1000`);
          expect([idOfKey(f.key), account, res.status]).toEqual([idOfKey(f.key), account, 200]);
          expect([idOfKey(f.key), account, res.body.nfts]).toEqual([
            idOfKey(f.key),
            account,
            nftsOfCollection(f, false, account),
          ]);
        }
      }
      // c0: P1 gave up its NFT in the second batch; c5: P2 sold its NFT on, to P1
      expect((await get(`${pathOf(c0, '/nfts')}?owner=${owner(1)}`)).body.nfts).toEqual([]);
      expect(((await get(`${pathOf(c0, '/nfts')}?owner=${owner(2)}`)).body.nfts as Obj[]).length).toBe(3);
      expect((await get(`${pathOf(c5, '/nfts')}?owner=${owner(2)}`)).body.nfts).toEqual([]);
      expect(((await get(`${pathOf(c5, '/nfts')}?owner=${owner(1)}`)).body.nfts as Obj[]).length).toBe(2);
      // an account that holds nothing here, and an address that is none: an empty list
      for (const account of [owner(99), 'xyz', '']) {
        const res = await get(`${pathOf(c2, '/nfts')}?owner=${account}`);
        expect([account, res.status, res.body.nfts.length]).toEqual([account, 200, account === '' ? 5 : 0]);
      }
      // the holdings are not the NFTs ever held: P1 held c0's second NFT, and the burned NFT of c6 has no holder
      expect((await get(`${pathOf(c6, '/nfts')}?owner=${owner(3)}&include_burned=true`)).body.nfts).toEqual([]);
    });

    it('pages with the marker (serial, nft_id): pages of 1, 2, 3 and 7 concatenate to the whole, with the owner too', async () => {
      const big = [...facts.values()].sort((a, b) => b.nfts.size - a.nfts.size)[0];
      if (xrpl) expect(big.nfts.size).toBeGreaterThan(40);
      await expectWalk(`${pathOf(big.key, '/nfts')}`, 'nfts', nftsOfCollection(big), [7, 50]);
      await expectWalk(`${pathOf(c2, '/nfts')}`, 'nfts', nftsOfCollection(factsOf(c2)));
      await expectWalk(`${pathOf(c4, '/nfts')}?include_burned=true`, 'nfts', nftsOfCollection(factsOf(c4), true));
      await expectWalk(
        `${pathOf(c2, '/nfts')}?owner=${owner(1)}`,
        'nfts',
        nftsOfCollection(factsOf(c2), false, owner(1)),
      );
      await expectWalk(
        `${pathOf(c4, '/nfts')}?owner=${owner(2)}`,
        'nfts',
        nftsOfCollection(factsOf(c4), false, owner(2)),
      );
      // the marker is the serial and the id of the last NFT of the page: on Xahau a serial is 0
      const page = await get(`${pathOf(c2, '/nfts')}?limit=2`);
      const last = (page.body.nfts as Obj[])[1];
      expect(decodeMarker(page.body.marker)).toEqual([xrpl ? last.serial : 0, last.nft_id]);
      expect(Object.keys(page.body)).toEqual(['result', 'coverage', 'count', 'marker', 'nfts']);
      // the same page with the owner holds the key of the holdings
      const mine = await get(`${pathOf(c2, '/nfts')}?limit=1&owner=${owner(1)}`);
      expect(decodeMarker(mine.body.marker)).toEqual([
        xrpl ? (mine.body.nfts[0].serial as number) : 0,
        mine.body.nfts[0].nft_id,
      ]);
    });

    it('last_sale has no converted_amount in a list, and has it in the detail of the same NFT', async () => {
      const id = synthId(0x100000 + 3 * 100);
      const listed = ((await get(`${pathOf(c3, '/nfts')}`)).body.nfts as Obj[]).find((n) => n.nft_id === id) as Obj;
      expect(listed.sale_count).toBe(3);
      expect(listed.last_sale).toMatchObject({ amount: '3', currency: world.native });
      expect(listed.last_sale).not.toHaveProperty('converted_amount');
      const detail = (await get(`/v2/nfts/${id}`)).body.nft as Obj;
      expect((detail.last_sale as Obj).converted_amount).toBe('3');
      expect({ ...detail, last_sale: undefined }).toEqual({ ...listed, last_sale: undefined });
      // it is the same with the owner
      const held = ((await get(`${pathOf(c3, '/nfts')}?owner=${owner(4)}`)).body.nfts as Obj[])[0];
      expect(held.last_sale).not.toHaveProperty('converted_amount');
    });
  });

  // -- the holders -------------------------------------------------------------------------------------------------------

  describe('GET …/holders', () => {
    it('holders: held descending then owner, gone holders left out, markers concatenate', async () => {
      for (const f of facts.values()) {
        const id = idOfKey(f.key);
        const res = await get(`${pathOf(f.key, '/holders')}?limit=1000`);
        expect([id, res.status]).toEqual([id, 200]);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'holders']);
        expect([id, res.body.holders]).toEqual([id, holdersOfCollection(f)]);
        expect(res.body.count).toBe(res.body.holders.length);
        // (and the holders of the collection row are these)
        expect([id, res.body.holders.length]).toEqual([id, collectionOf(f, rates).holders]);
        for (const holder of res.body.holders as Obj[]) expectOrdered(holder, ['owner', 'held'], id);
      }
      // c0: P1 gave up its NFT, P2 holds the three: P1 had a row of held 1, and the newest says 0
      expect((await get(pathOf(c0, '/holders'))).body.holders).toEqual([{ owner: owner(2), held: 3 }]);
      // c2: P1 and P2 hold two each, P3 one: the most first, the two with the same number by owner
      expect((await get(pathOf(c2, '/holders'))).body.holders).toEqual([
        ...[owner(1), owner(2)].sort().map((o) => ({ owner: o, held: 2 })),
        { owner: owner(3), held: 1 },
      ]);
      // c1: three holders of one each, by owner
      expect((await get(pathOf(c1, '/holders'))).body.holders).toEqual(
        [owner(1), owner(4), owner(5)].sort().map((o) => ({ owner: o, held: 1 })),
      );
      // c7: every NFT burned, nobody holds
      expect((await get(pathOf(c7, '/holders'))).body).toMatchObject({ count: 0, holders: [] });
      const big = [...facts.values()].sort((a, b) => holdersOfCollection(b).length - holdersOfCollection(a).length)[0];
      expect(holdersOfCollection(big).length).toBeGreaterThanOrEqual(3);
      await expectWalk(pathOf(big.key, '/holders'), 'holders', holdersOfCollection(big));
      await expectWalk(pathOf(c1, '/holders'), 'holders', holdersOfCollection(factsOf(c1)));
      // the marker is how many the last holder of the page holds, and the owner
      const page = await get(`${pathOf(c2, '/holders')}?limit=1`);
      expect(decodeMarker(page.body.marker)).toEqual([2, [owner(1), owner(2)].sort()[0]]);
      expect(Object.keys(page.body)).toEqual(['result', 'coverage', 'count', 'marker', 'holders']);
      // a page that starts inside a figure goes on from the owner
      const second = await get(
        `${pathOf(c1, '/holders')}?limit=1&marker=${base64([1, [owner(1), owner(4), owner(5)].sort()[0]])}`,
      );
      expect(second.body.holders).toEqual([{ owner: [owner(1), owner(4), owner(5)].sort()[1], held: 1 }]);
    });
  });

  // -- the sales ---------------------------------------------------------------------------------------------------------

  describe('GET …/sales', () => {
    it('sales: newest first with descending, converted_amount, window and markers', async () => {
      for (const f of facts.values()) {
        const id = idOfKey(f.key);
        const want = salesOfCollection(f).map((e) => saleOf(e, rates));
        const up = await get(`${pathOf(f.key, '/sales')}?limit=1000`);
        const down = await get(`${pathOf(f.key, '/sales')}?limit=1000&descending=true`);
        expect([id, up.status, down.status]).toEqual([id, 200, 200]);
        expect(Object.keys(up.body)).toEqual(['result', 'coverage', 'count', 'sales']);
        expect([id, up.body.sales]).toEqual([id, want]);
        expect([id, down.body.sales]).toEqual([id, [...want].reverse()]);
        expect(up.body.count).toBe(want.length);
        for (const sale of up.body.sales as Obj[]) expectOrdered(sale, SALE_KEYS, id);
      }
      // c3: native, in JPY with no rate, and brokered: the first has its price itself, the second none, the third its broker
      const [a, b, c] = (await get(pathOf(c3, '/sales'))).body.sales as Obj[];
      expect(a).toMatchObject({ amount: '250.5', currency: world.native, converted_amount: '250.5', mode: 'direct' });
      expect(a).not.toHaveProperty('amount_issuer');
      expect(b).toMatchObject({ amount: '7000', currency: 'JPY', amount_issuer: accountAt(0x62), mode: 'direct' });
      expect(b).not.toHaveProperty('converted_amount');
      expect(c).toMatchObject({
        amount: '3',
        converted_amount: '3',
        mode: 'brokered',
        broker: accountAt(0x77),
        broker_fee: '0.5',
      });
      // c4: 40 USD at a rate of 4 is 10 coins
      const [usd] = (await get(pathOf(c4, '/sales'))).body.sales as Obj[];
      expect(usd).toMatchObject({
        amount: '40',
        currency: 'USD',
        amount_issuer: accountAt(0x61),
        converted_amount: '10',
      });
      expect(Object.keys(usd)).toEqual(
        SALE_KEYS.filter(
          (k) => !['broker', 'broker_fee'].includes(k) && (xrpl || !['taxon', 'serial', 'royalty_est'].includes(k)),
        ),
      );
      // a collection with no sale lists none
      expect((await get(pathOf(c2, '/sales'))).body).toMatchObject({ count: 0, sales: [] });
    });

    it('a row written twice is served once, and a page cut inside the duplicates neither repeats nor skips a sale', async () => {
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.CollectionNftEvents} WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32} AND event = 'sale'`,
        { ...WRITTEN_TWICE },
      );
      expect(Number(n)).toBe(6);
      const want = salesOfCollection(factsOf(WRITTEN_TWICE)).map((e) => saleOf(e, rates));
      expect(want).toHaveLength(3);
      expect((await get(pathOf(WRITTEN_TWICE, '/sales'))).body.sales).toEqual(want);
      await expectWalk(pathOf(WRITTEN_TWICE, '/sales'), 'sales', want, [1, 2]);
      await expectWalk(`${pathOf(WRITTEN_TWICE, '/sales')}?descending=true`, 'sales', [...want].reverse(), [1, 2]);
      // and neither the stats nor the collection count them twice
      expect(objectOf(WRITTEN_TWICE)).toMatchObject({ sales_count: 3, volume_native: '253.5' });
      const list = (await get('/v2/nft_collections?limit=1000')).body.collections as Obj[];
      expect(
        list.find((c) => c.issuer === WRITTEN_TWICE.issuer && (c.taxon ?? 0) === (xrpl ? WRITTEN_TWICE.taxon_key : 0)),
      ).toMatchObject({
        sales_count: 3,
        volume_native: '253.5',
      });
    });

    it('start and end are dates: the sales of the ledgers that closed in the window, the second each names included', async () => {
      const sales = salesOfCollection(factsOf(c3));
      const [a, b, c] = sales;
      expect(new Set(sales.map((e) => e.ledger_index)).size).toBe(3);
      const served = (query: string): Promise<unknown[]> =>
        get(`${pathOf(c3, '/sales')}?${query}`).then((r) => (r.body.sales as Obj[]).map((s) => s.ledger_index));
      expect(await served(`start=${iso(b.close_time)}`)).toEqual([b.ledger_index, c.ledger_index]);
      expect(await served(`end=${iso(b.close_time)}`)).toEqual([a.ledger_index, b.ledger_index]);
      expect(await served(`start=${iso(b.close_time)}&end=${iso(b.close_time)}`)).toEqual([b.ledger_index]);
      expect(await served(`start=${iso(b.close_time)}&end=${iso(c.close_time)}&descending=true`)).toEqual([
        c.ledger_index,
        b.ledger_index,
      ]);
      // a start a second after the ledger leaves it out
      expect(await served(`start=${iso(b.close_time + 1)}`)).toEqual([c.ledger_index]);
      // a window with no ledger in it, and one before the first, are empty lists
      const empty = await get(`${pathOf(c3, '/sales')}?start=2001-01-01&end=2001-01-02`);
      expect([empty.status, empty.body.count, empty.body.sales]).toEqual([200, 0, []]);
      expect(empty.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
      expect(Object.keys(empty.body)).toEqual(['result', 'coverage', 'count', 'sales']);
    });

    it('pages with the marker (ledger_index, tx_index, event_index), both ways, with a window', async () => {
      const f = factsOf(c3);
      const want = salesOfCollection(f).map((e) => saleOf(e, rates));
      await expectWalk(pathOf(c3, '/sales'), 'sales', want, [1, 2]);
      await expectWalk(`${pathOf(c3, '/sales')}?descending=true`, 'sales', [...want].reverse(), [1, 2]);
      const [, b] = salesOfCollection(f);
      await expectWalk(`${pathOf(c3, '/sales')}?start=${iso(b.close_time)}`, 'sales', want.slice(1), [1]);
      const page = await get(`${pathOf(c3, '/sales')}?limit=1`);
      expect(decodeMarker(page.body.marker)).toEqual([
        salesOfCollection(f)[0].ledger_index,
        salesOfCollection(f)[0].tx_index,
        salesOfCollection(f)[0].event_index,
      ]);
      expect(Object.keys(page.body)).toEqual(['result', 'coverage', 'count', 'marker', 'sales']);
      // the biggest collection of sales, by pages
      const busiest = [...facts.values()].sort((x, y) => salesOfCollection(y).length - salesOfCollection(x).length)[0];
      await expectWalk(
        pathOf(busiest.key, '/sales'),
        'sales',
        salesOfCollection(busiest).map((e) => saleOf(e, rates)),
        [1],
      );
    });
  });

  // -- the stats ---------------------------------------------------------------------------------------------------------

  describe('GET …/stats', () => {
    it('stats: a row per active UTC day; a day whose only sale has no rate has sales_count 1 and no price fields', async () => {
      for (const f of facts.values()) {
        const id = idOfKey(f.key);
        const res = await get(`${pathOf(f.key, '/stats')}?${WINDOW}`);
        expect([id, res.status]).toEqual([id, 200]);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'days']);
        const want = daysOf(f.events, rates);
        expect([id, res.body.days]).toEqual([id, want]);
        expect(res.body.count).toBe(want.length);
        for (const day of res.body.days as Obj[]) expectOrdered(day, DAY_KEYS, id);
        const down = await get(`${pathOf(f.key, '/stats')}?${WINDOW}&descending=true`);
        expect([id, down.body.days]).toEqual([id, [...want].reverse()]);
      }
      // the recorded sale in an issued currency that has no rate: it counts, and it has no price
      const unrated = recorded.find((e) => e.event === 'sale' && e.amount_issuer !== '') as Ev;
      const key = { issuer: unrated.issuer, taxon_key: unrated.taxon_key };
      expect((await get(`${pathOf(key, '/stats')}?${WINDOW}`)).body.days).toEqual([
        {
          date: `${dayOf(unrated.close_time)}T00:00:00Z`,
          sales_count: 1,
          volume_native: '0',
          mints: factsOf(key).events.filter((e) => e.event === 'mint').length,
          burns: factsOf(key).events.filter((e) => e.event === 'burn').length,
        },
      ]);
      // c4: a day with a sale at a rate: 40 USD / 4 is 10, the price, its average and its minimum
      const days = (await get(`${pathOf(c4, '/stats')}?${WINDOW}`)).body.days as Obj[];
      const sold = days.find((d) => d.sales_count === 1) as Obj;
      expect(sold).toMatchObject({ volume_native: '10', avg_price_native: '10', min_price_native: '10' });
      expect(Object.keys(sold)).toEqual(DAY_KEYS);
      // c3: three sales on days of the seed: 250.5 and a brokered 3 are priced, the sale in JPY is not
      const c3days = (await get(`${pathOf(c3, '/stats')}?${WINDOW}`)).body.days as Obj[];
      expect(c3days.reduce((n, d) => n + (d.sales_count as number), 0)).toBe(3);
      expect(c3days.reduce((v, d) => v.plus(d.volume_native as string), new BigNumber(0)).toFixed()).toBe('253.5');
      const priced = c3days.filter((d) => 'avg_price_native' in d);
      expect(priced.length).toBeGreaterThanOrEqual(1);
      // a day that has only mints has a volume of 0 and no prices
      const mintOnly = (await get(`${pathOf(c2, '/stats')}?${WINDOW}`)).body.days as Obj[];
      expect(mintOnly).toEqual([
        { date: `${dayOf(slots[0].close)}T00:00:00Z`, sales_count: 0, volume_native: '0', mints: 5, burns: 0 },
      ]);
    });

    it('stats: 400 start is required, and invalid window - use at most 366 days before any read', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const answer = async (path: string): Promise<[number, string]> => {
        const res = await get(path);
        return [res.status, res.body.message];
      };
      const stats = pathOf(c0, '/stats');
      expect(await answer(stats)).toEqual([400, 'start is required']);
      expect(await answer(`${stats}?end=2026-10-25`)).toEqual([400, 'start is required']);
      expect(await answer(`${stats}?start=`)).toEqual([400, 'invalid start date format']);
      expect(await answer(`${stats}?start=x&end=y`)).toEqual([400, 'invalid start date format']);
      expect(await answer(`${stats}?start=2026-10-24&end=y`)).toEqual([400, 'invalid end date format']);
      // a year is allowed: 366 days
      const now = Date.now();
      const longAgo = new Date(now - 400 * 86_400_000).toISOString().slice(0, 10);
      expect(await answer(`${stats}?start=${longAgo}`)).toEqual([400, 'invalid window - use at most 366 days']);
      expect(await answer(`${stats}?start=2024-01-01&end=2025-01-01`)).toEqual([
        400,
        'invalid window - use at most 366 days',
      ]);
      expect(await answer(`${stats}?start=2020&end=2021`)).toEqual([400, 'invalid window - use at most 366 days']);
      // every one of them before any read: not the collection, not the coverage
      expect(spy).not.toHaveBeenCalled();
      // the checks of the key come first: the issuer and the taxon, then these
      expect(await answer(`${xrpl ? '/v2/nft_collections/xyz/1' : '/v2/nft_collections/xyz'}/stats`)).toEqual([
        400,
        'invalid issuer address',
      ]);
      expect(spy).not.toHaveBeenCalled();
      if (xrpl) {
        expect(await answer(`/v2/nft_collections/${c0.issuer}/nope/stats`)).toEqual([400, 'invalid taxon']);
        expect(spy).not.toHaveBeenCalled();
      }
      spy.mockRestore();
      // 366 days exactly is a window, and a start without an end reaches to now
      const full = new Date(Date.UTC(2024, 0, 1)).toISOString().slice(0, 10);
      const leap = await get(`${stats}?start=${full}&end=2024-12-31`);
      expect([leap.status, leap.body.days]).toEqual([200, []]);
      expect(leap.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
      // the days of the last two days, whatever the date is today: the window ends now
      const since = new Date(now - 2 * 86_400_000);
      const recent = await get(`${stats}?start=${iso(Math.floor(since.getTime() / 1000))}`);
      expect(recent.status).toBe(200);
      expect(recent.body.days).toEqual(
        daysOf(
          factsOf(c0).events.filter((e) => e.close_time >= Math.floor(since.getTime() / 1000)),
          rates,
        ),
      );
    });

    it('volume_native of the collection equals /stats over all its days', async () => {
      // (the rates were stored before the aggregates were built: the volume of a collection is worked out with the rates known when
      // it is computed, and /stats converts at read time, so both see the same rates)
      const list = (await get('/v2/nft_collections?limit=1000')).body.collections as Obj[];
      expect(list.length).toBe(objects.length);
      let withVolume = 0;
      for (const collection of list) {
        const key = { issuer: collection.issuer as string, taxon_key: xrpl ? (collection.taxon as number) : 0 };
        const days = (await get(`${pathOf(key, '/stats')}?${WINDOW}`)).body.days as Obj[];
        const volume = days.reduce((sum, d) => sum.plus(d.volume_native as string), new BigNumber(0));
        const sales = days.reduce((n, d) => n + (d.sales_count as number), 0);
        expect([idOfKey(key), volume.toFixed(), sales]).toEqual([
          idOfKey(key),
          collection.volume_native,
          collection.sales_count,
        ]);
        const mints = days.reduce((n, d) => n + (d.mints as number), 0);
        const burns = days.reduce((n, d) => n + (d.burns as number), 0);
        expect([idOfKey(key), mints, burns]).toEqual([idOfKey(key), collection.minted, collection.burned]);
        if (volume.gt(0)) withVolume += 1;
      }
      expect(withVolume).toBeGreaterThanOrEqual(4);
    });
  });

  // -- the contract ------------------------------------------------------------------------------------------------------

  describe('the contract of the routes', () => {
    /** The five lists: a path with a few rows, the key of its rows, and a path that lists none. */
    const lists = (): Array<{
      name: string;
      path: string;
      key: string;
      want: unknown[];
      empty: string;
      csvColumns: string[];
      file: string;
      descending: boolean;
    }> => [
      {
        name: 'the collections',
        path: '/v2/nft_collections',
        key: 'collections',
        want: sortedCollections(objects, 'volume', true),
        empty: `/v2/nft_collections?issuer=${accountAt(0x9999)}`,
        csvColumns: [
          'issuer',
          'taxon',
          'kind',
          'supply',
          'holders',
          'minted',
          'burned',
          'sales_count',
          'volume_native',
          'first_mint.ledger_index',
          'first_mint.tx_hash',
          'first_mint.executed_time',
          'last_mint.ledger_index',
          'last_mint.tx_hash',
          'last_mint.executed_time',
          'last_ledger',
        ],
        file: 'nft collections',
        descending: true,
      },
      {
        name: 'the NFTs',
        path: `${pathOf(c2, '/nfts')}`,
        key: 'nfts',
        want: nftsOfCollection(factsOf(c2)),
        empty: `${pathOf(c2, '/nfts')}?owner=${owner(99)}`,
        csvColumns: [
          'nft_id',
          'kind',
          'issuer',
          'taxon',
          'serial',
          'flags',
          'transfer_fee',
          'owner',
          'owner_since.ledger_index',
          'owner_since.tx_hash',
          'owner_since.executed_time',
          'uri',
          'digest',
          'minted.ledger_index',
          'minted.tx_hash',
          'minted.executed_time',
          'minted.by',
          'minted.to',
          'burned',
          'burned_at.ledger_index',
          'burned_at.tx_hash',
          'burned_at.executed_time',
          'burned_at.by',
          'sale_count',
          'last_sale.amount',
          'last_sale.currency',
          'last_sale.amount_issuer',
          'last_sale.converted_amount',
          'last_sale.ledger_index',
          'last_sale.tx_hash',
          'last_sale.executed_time',
        ],
        file: fileOf(c2, 'nfts'),
        descending: false,
      },
      {
        name: 'the holders',
        path: pathOf(c2, '/holders'),
        key: 'holders',
        want: holdersOfCollection(factsOf(c2)),
        empty: pathOf(c7, '/holders'),
        csvColumns: ['owner', 'held'],
        file: fileOf(c2, 'holders'),
        descending: false,
      },
      {
        name: 'the sales',
        path: pathOf(c3, '/sales'),
        key: 'sales',
        want: salesOfCollection(factsOf(c3)).map((e) => saleOf(e, rates)),
        empty: pathOf(c2, '/sales'),
        csvColumns: SALE_KEYS,
        file: fileOf(c3, 'sales'),
        descending: true,
      },
      {
        name: 'the stats',
        path: `${pathOf(c3, '/stats')}?${WINDOW}`,
        key: 'days',
        want: daysOf(factsOf(c3).events, rates),
        empty: `${pathOf(c3, '/stats')}?start=2001-01-01&end=2001-01-02`,
        csvColumns: DAY_KEYS,
        file: fileOf(c3, 'stats'),
        descending: true,
      },
    ];
    /** `path` with the parameter added: after a `?`, or starting one. */
    const withParam = (path: string, param: string): string => `${path}${path.includes('?') ? '&' : '?'}${param}`;

    it('the list and the four sub-lists pass the shared list tests: empty, markers concatenate, descending, unknown parameters ignored', async () => {
      for (const list of lists()) {
        // the answer: coverage right after result, the rows, count; nothing else
        const res = await get(withParam(list.path, 'limit=1000'));
        expect([list.name, res.status]).toEqual([list.name, 200]);
        expect([list.name, res.body[list.key]]).toEqual([list.name, list.want]);
        expect(res.body.count).toBe(list.want.length);
        expect(Object.keys(res.body)[1]).toBe('coverage');
        expect(res.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });

        // empty: a list with no row is a 200 with count 0, no marker, and the coverage
        const empty = await get(list.empty);
        expect([list.name, empty.status, empty.body.count, empty.body[list.key]]).toEqual([list.name, 200, 0, []]);
        expect(empty.body).not.toHaveProperty('marker');
        expect(Object.keys(empty.body)).toEqual(
          list.key === 'collections'
            ? ['result', 'coverage', 'total', 'count', 'collections']
            : ['result', 'coverage', 'count', list.key],
        );
        expect(empty.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
        const emptyCsv = await get(withParam(list.empty, 'format=csv'));
        expect([list.name, emptyCsv.status, emptyCsv.text]).toEqual([list.name, 200, '']);

        // markers concatenate, both ways where the list has two
        const limits = list.want.length > 3 ? [1, 2, 3] : [1, 2];
        await expectWalk(list.path, list.key, list.want, limits);
        if (list.descending) {
          const param = list.key === 'collections' ? 'descending=false' : 'descending=true';
          const reversed =
            list.key === 'collections' ? sortedCollections(objects, 'volume', false) : [...list.want].reverse();
          expect([list.name, (await get(withParam(list.path, `${param}&limit=1000`))).body[list.key]]).toEqual([
            list.name,
            reversed,
          ]);
          await expectWalk(withParam(list.path, param), list.key, reversed, limits);
        } else {
          // the NFTs and the holders have no direction: descending is a parameter they do not know
          expect((await get(withParam(list.path, 'descending=true&limit=1000'))).body[list.key]).toEqual(list.want);
        }

        // unknown parameters are ignored, and limits are read like the other lists': 200 by default, a decimal cut, below one default
        const noisy = await get(withParam(list.path, 'nothing=1&interval=day&type=sell&limit=1000'));
        expect([list.name, noisy.body[list.key]]).toEqual([list.name, list.want]);
        // (the stats have no limit: they are a year at most)
        if (list.key === 'days') continue;
        for (const [limit, count] of [
          ['', list.want.length],
          ['0', list.want.length],
          ['abc', list.want.length],
          ['1.9', 1],
          ['5000', list.want.length],
        ] as const) {
          const limited = await get(withParam(list.path, `limit=${limit}`));
          expect([list.name, limit, limited.status, limited.body.count]).toEqual([list.name, limit, 200, count]);
        }
      }
    });

    it('sets the Link header on a page with a next one, for JSON and CSV, and none on the last page', async () => {
      for (const list of lists().filter((l) => l.key !== 'days')) {
        const page = await get(withParam(list.path, 'limit=1'));
        const origin = new URL(page.request.url).origin;
        const marker = page.body.marker as string;
        expect([list.name, typeof marker]).toEqual([list.name, 'string']);
        expect(page.headers.link).toBe(`<${origin}${withParam(list.path, 'limit=1')}&marker=${marker}>; rel="next"`);
        const csv = await get(withParam(list.path, 'limit=1&format=csv'));
        expect(csv.headers.link).toBe(
          `<${origin}${withParam(list.path, 'limit=1&format=csv')}&marker=${marker}>; rel="next"`,
        );
        expect((await get(withParam(list.path, 'limit=1000'))).headers.link).toBeUndefined();
        expect((await get(withParam(list.path, 'limit=1000&format=csv'))).headers.link).toBeUndefined();
      }
      // the stats have one page
      expect((await get(`${pathOf(c3, '/stats')}?${WINDOW}`)).headers.link).toBeUndefined();
    });

    it('format=csv: text/csv named for the list, one row each, the same columns on every page, no coverage', async () => {
      for (const list of lists()) {
        const res = await get(withParam(list.path, 'format=csv&limit=1000'));
        expect([list.name, res.status]).toEqual([list.name, 200]);
        expect(res.headers['content-type']).toMatch(/^text\/csv/);
        expect(res.headers['content-disposition']).toBe(csvDisposition(list.file));
        const table = lines(res.text).map(cells);
        expect([list.name, table.length]).toEqual([list.name, 1 + list.want.length]);
        // the columns are those of the list's objects, in order, whatever the first rows hold: the same on every page
        const header = list.csvColumns.map((c) => `"${c}"`);
        expect([list.name, table[0]]).toEqual([list.name, header]);
        for (const row of table) expect(row).toHaveLength(header.length);
        expect(res.text).not.toContain('coverage');
        expect(res.text).not.toContain('from_ledger_index');
        if (list.key === 'days') continue;
        let marker: string | undefined;
        let pages = 0;
        do {
          const more = marker ? `&marker=${marker}` : '';
          const part = await get(withParam(list.path, `format=csv&limit=2${more}`));
          expect([list.name, pages, lines(part.text)[0].split(',')]).toEqual([list.name, pages, header]);
          marker = ((await get(withParam(list.path, `limit=2${more}`))).body as { marker?: string }).marker;
          pages += 1;
        } while (marker && pages < 40);
        expect(pages).toBe(Math.ceil(list.want.length / 2));
      }
      // a cell is empty where the object has no key: a collection with no mint has none of first_mint and last_mint
      const csv = lines((await get('/v2/nft_collections?format=csv&limit=1000')).text).map(cells);
      const mintColumn = csv[0].indexOf('"first_mint.ledger_index"');
      const noMint = csv.slice(1).filter((row) => row[mintColumn] === '""');
      expect(noMint.length).toBe(objects.filter((o) => !('first_mint' in o)).length);
      // and the file name is that of the path: <issuer>[ <taxon>] - <list>
      for (const tail of ['nfts', 'holders', 'sales']) {
        const res = await get(`${pathOf(c1, `/${tail}`)}?format=csv`);
        expect(res.headers['content-disposition']).toBe(csvDisposition(fileOf(c1, tail)));
      }
      // an error is not a CSV
      const bad = await get('/v2/nft_collections?format=csv&sort=nope');
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid sort' }]);
      const missing = await get(`${otherFormOf(c1, '/nfts')}?format=csv`);
      expect([missing.status, missing.body.message]).toEqual([404, 'collection not found']);
    });

    it('answers Cache-Control private, max-age=60 on its answers, no-store on its errors, and 401 without a key', async () => {
      for (const list of lists()) {
        const ok = await get(list.path);
        expect([list.name, ok.status, ok.headers['cache-control']]).toEqual([list.name, 200, 'private, max-age=60']);
        const unauthorized = await h.http().get(list.path);
        expect([list.name, unauthorized.status]).toEqual([list.name, 401]);
      }
      const detail = pathOf(c1);
      expect([(await get(detail)).headers['cache-control'], (await h.http().get(detail)).status]).toEqual([
        'private, max-age=60',
        401,
      ]);
      for (const path of [otherFormOf(c1), otherFormOf(c1, '/nfts'), '/v2/nft_collections?sort=nope']) {
        const bad = await get(path);
        expect([path, bad.headers['cache-control']]).toEqual([path, 'no-store']);
      }
    });

    it('answers the errors in the order issuer, taxon, the others of the route, the marker, then the 404', async () => {
      const answer = async (path: string): Promise<[number, string]> => {
        const res = await get(path);
        return [res.status, res.body.message];
      };
      const unknown = { issuer: accountAt(0x9997), taxon_key: xrpl ? 4 : 0 };
      const taxon = (n: string): string => (xrpl ? `/${n}` : '');
      for (const tail of ['nfts', 'holders', 'sales']) {
        // the issuer first, then the taxon
        expect(await answer(`/v2/nft_collections/xyz${taxon('x')}/${tail}?marker=${BAD_MARKER}`)).toEqual([
          400,
          'invalid issuer address',
        ]);
        if (xrpl)
          expect(await answer(`/v2/nft_collections/${c0.issuer}/x/${tail}?marker=${BAD_MARKER}`)).toEqual([
            400,
            'invalid taxon',
          ]);
        // then the marker, whatever the collection is
        expect(await answer(`${pathOf(unknown, `/${tail}`)}?marker=${BAD_MARKER}`)).toEqual([400, 'invalid marker']);
        expect(await answer(`${otherFormOf(c0, `/${tail}`)}?marker=${BAD_MARKER}`)).toEqual([400, 'invalid marker']);
        // and last, the collection
        expect(await answer(pathOf(unknown, `/${tail}`))).toEqual([404, 'collection not found']);
        expect(await answer(otherFormOf(c0, `/${tail}`))).toEqual([404, 'collection not found']);
      }
      // the sales: the dates before the marker
      expect(await answer(`${pathOf(c0, '/sales')}?start=x&end=x&marker=${BAD_MARKER}`)).toEqual([
        400,
        'invalid start date format',
      ]);
      expect(await answer(`${pathOf(c0, '/sales')}?end=x&marker=${BAD_MARKER}`)).toEqual([
        400,
        'invalid end date format',
      ]);
      expect(await answer(`${pathOf(c0, '/sales')}?marker=${BAD_MARKER}`)).toEqual([400, 'invalid marker']);
      // the stats: the window, then the 404
      expect(await answer(`${pathOf(unknown, '/stats')}?${WINDOW}`)).toEqual([404, 'collection not found']);
      expect(await answer(pathOf(unknown, '/stats'))).toEqual([400, 'start is required']);
      expect(await answer(`${otherFormOf(c0, '/stats')}`)).toEqual([400, 'start is required']);
    });

    it('answers 400 invalid marker for a marker that is none of its own', async () => {
      const markers: Record<string, string[]> = {
        nfts: [
          base64([]),
          base64([1]),
          base64([1, 2]),
          base64(['a', 'b']),
          base64([-1, 'x']),
          base64([1, 'x', 3]),
          'not base64 !',
        ],
        holders: [
          base64([]),
          base64([1]),
          base64(['a', 'b']),
          base64([-1, 'x']),
          base64([2 ** 32, 'x']),
          base64([1, 2]),
          base64([1, 'x', 3]),
        ],
        sales: [
          base64([]),
          base64([1, 2]),
          base64([1, 2, 70_000]),
          base64(['a', 1, 2]),
          base64([-1, 0, 0]),
          base64([null, 1, 2]),
          'not base64 !',
        ],
      };
      for (const [tail, list] of Object.entries(markers)) {
        for (const marker of list) {
          const res = await get(`${pathOf(c2, `/${tail}`)}?marker=${encodeURIComponent(marker)}`);
          expect([tail, marker, res.status, res.body]).toEqual([
            tail,
            marker,
            400,
            { result: 'error', message: 'invalid marker' },
          ]);
        }
      }
    });

    describe('when the database fails', () => {
      const cases: [string, string, string][] = [
        ['the list', '/v2/nft_collections', 'unable to retrieve collections'],
        ['the detail', pathOf(c1), 'unable to retrieve collection'],
        ['the NFTs', pathOf(c1, '/nfts'), 'unable to retrieve nfts'],
        ['the NFTs of an owner', `${pathOf(c1, '/nfts')}?owner=${owner(1)}`, 'unable to retrieve nfts'],
        ['the holders', pathOf(c1, '/holders'), 'unable to retrieve holders'],
        ['the sales', pathOf(c1, '/sales'), 'unable to retrieve sales'],
        ['the stats', `${pathOf(c1, '/stats')}?${WINDOW}`, 'unable to retrieve stats'],
      ];

      it.each(cases)('%s is a 500 with its own message', async (_name, path, message) => {
        await api.ok('/v2/test-cache/clear', 'result');
        jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
        const res = await get(path);
        expect([res.status, res.body]).toEqual([500, { result: 'error', message }]);
      });

      it('a failed read in the middle of a request fails it, and nothing is kept: the next request is whole again', async () => {
        const real = h.ch.query.bind(h.ch);
        // the page of NFTs read after the collection's row and the coverage: the read of `nfts` fails
        jest
          .spyOn(h.ch, 'query')
          .mockImplementation(((sql: string, ...rest: unknown[]) =>
            sql.includes(`FROM ${Table.Nfts}`)
              ? Promise.reject(new Error('boom'))
              : (real as (...a: unknown[]) => unknown)(sql, ...rest)) as never);
        await api.ok('/v2/test-cache/clear', 'result');
        const failed = await get(pathOf(c1, '/nfts'));
        expect([failed.status, failed.body]).toEqual([500, { result: 'error', message: 'unable to retrieve nfts' }]);
        jest.restoreAllMocks();
        expect((await get(pathOf(c1, '/nfts'))).status).toBe(200);
        // a failed read of the list is not kept either
        jest
          .spyOn(h.ch, 'query')
          .mockImplementation(((sql: string, ...rest: unknown[]) =>
            sql.includes(`FROM ${Table.NftCollections}`)
              ? Promise.reject(new Error('boom'))
              : (real as (...a: unknown[]) => unknown)(sql, ...rest)) as never);
        await api.ok('/v2/test-cache/clear', 'result');
        expect((await get('/v2/nft_collections')).status).toBe(500);
        jest.restoreAllMocks();
        expect((await get('/v2/nft_collections')).status).toBe(200);
      });

      it('a mistake of the client stays a 400 while the database is down', async () => {
        jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
        for (const path of [
          '/v2/nft_collections?issuer=xyz',
          '/v2/nft_collections?sort=nope',
          `/v2/nft_collections?marker=${BAD_MARKER}`,
          pathOf({ issuer: 'xyz', taxon_key: 1 }),
          `${pathOf(c1, '/nfts')}?marker=${BAD_MARKER}`,
          `${pathOf(c1, '/holders')}?marker=${BAD_MARKER}`,
          `${pathOf(c1, '/sales')}?start=x`,
          `${pathOf(c1, '/sales')}?marker=${BAD_MARKER}`,
          pathOf(c1, '/stats'),
          `${pathOf(c1, '/stats')}?start=2020&end=2021`,
        ]) {
          expect([path, (await get(path)).status]).toEqual([path, 400]);
        }
      });
    });
  });

  it('the aggregates were built over the seed: the collections, their holders, the NFTs and their holdings', async () => {
    const count = async (table: Table): Promise<number> =>
      Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0].n);
    expect(await count(Table.NftCollections)).toBeGreaterThanOrEqual(objects.length);
    expect(await count(Table.NftCollectionHolders)).toBeGreaterThan(0);
    expect(await count(Table.Nfts)).toBeGreaterThan(byNft.size);
    // (the events above the head of the seed are not in the aggregates)
    const [above] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.Nfts} WHERE nft_id = {id:String}`,
      { id: ABOVE },
    );
    expect(Number(above.n)).toBe(0);
  });
});

// =====================================================================================================================
// A database of its own: a collection the job has not counted yet, and the coverage

describe.each(WORLDS)('the NFT collection routes on $network, with a ledger or two of its own', (world) => {
  const E = world.start;
  const xrpl = world.kind === 'nftoken';
  const issuer = accountAt(0x71);
  const taxon = 11;
  const key = { issuer, taxon_key: xrpl ? taxon : 0 };
  const path = (tail = ''): string =>
    xrpl ? `/v2/nft_collections/${issuer}/${taxon}${tail}` : `/v2/nft_collections/${issuer}${tail}`;
  /** Close times grow with the ledger: a ledger is 10 seconds after the one below it. */
  const closeOf = (offset: number): number => 1_700_000_000 + (offset + 10) * 10;

  async function startCase(): Promise<{ h: Harness; api: ApiClient }> {
    const h = await startHarness({
      seed: 'none',
      network: world.network,
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    return { h, api: await h.api() };
  }

  /** Two committed ledgers of the current parser and two NFTs of the collection minted in the second. */
  async function seedCollection(h: Harness): Promise<void> {
    await h.ch.insert(
      Table.Ledgers,
      [0, 1].map((offset) => ({ ...ledgerRow(E + offset, closeOf(offset)), parser_version: NFT_PARSER_VERSION })),
    );
    const identity = xrpl
      ? { kind: 'nftoken' as const, issuer, taxon, taxon_key: taxon, nft_flags: 8, transfer_fee: 0 }
      : { kind: 'uritoken' as const, issuer, taxon: null, taxon_key: 0, nft_flags: 1, transfer_fee: 0 };
    await insertNftEvents(
      h,
      [1, 2].map((n) =>
        nftEventRow({
          ...identity,
          nft_id: synthId(0xb0000 + n),
          serial: xrpl ? n : 0,
          ledger_index: E + 1,
          close_time: closeOf(1),
          tx_index: 3000 + n,
          account: issuer,
          to_account: owner(n),
        }),
      ),
    );
  }

  it('a collection younger than the last run of the job is 404 on its sub-routes too', async () => {
    const { h, api } = await startCase();
    try {
      await seedCollection(h);
      const routes = ['', '/nfts', '/holders', '/sales', '/stats?start=2020-01-01&end=2020-02-01'];
      // the events are there, the collection is not: no row of nft_collections yet
      for (const tail of routes) {
        const res = await api.get(path(tail));
        expect([tail, res.status, res.body]).toEqual([tail, 404, { result: 'error', message: 'collection not found' }]);
      }
      // and the list has none
      const before = await api.get('/v2/nft_collections');
      expect([before.status, before.body.total, before.body.collections]).toEqual([200, 0, []]);

      await buildNftAggregates(h, world.native);
      await api.ok('/v2/test-cache/clear', 'result');
      for (const tail of routes) {
        const res = await api.get(path(tail));
        expect([tail, res.status]).toEqual([tail, 200]);
      }
      expect((await api.get(path())).body.collection).toMatchObject({ issuer, supply: 2, holders: 2, minted: 2 });
      expect((await api.get(path('/nfts'))).body.count).toBe(2);
      expect((await api.get(path('/holders'))).body.holders).toEqual(
        [owner(1), owner(2)].sort().map((o) => ({ owner: o, held: 1 })),
      );
      const list = await api.get('/v2/nft_collections');
      expect([list.body.total, list.body.collections.length]).toEqual([1, 1]);
    } finally {
      await h.close();
    }
  });

  it('rounds the average to the 6th decimal and keeps the lowest price of the day: three sales of 1, 2 and 4 at a rate of 3', async () => {
    const { h, api } = await startCase();
    try {
      await seedCollection(h);
      const day = dayOf(closeOf(1));
      await h.ch.insert(Table.NativeRatesDaily, rateRows([{ currency: 'USD', issuer: USD_ISSUER, day, rate: '3' }]));
      const identity = xrpl
        ? { kind: 'nftoken' as const, issuer, taxon, taxon_key: taxon, nft_flags: 8, transfer_fee: 0 }
        : { kind: 'uritoken' as const, issuer, taxon: null, taxon_key: 0, nft_flags: 1, transfer_fee: 0 };
      // (the sales are of the NFTs seeded, in the ledger that minted them: 1/3, 2/3 and 4/3 as the prices round)
      await insertNftEvents(
        h,
        [1, 2, 1].map((n, i) =>
          nftEventRow({
            ...identity,
            nft_id: synthId(0xb0000 + n),
            serial: xrpl ? n : 0,
            ledger_index: E + 1,
            close_time: closeOf(1),
            tx_index: 3100 + i,
            event: 'sale',
            account: owner(n + 2),
            from_account: owner(n),
            to_account: owner(n + 2),
            amount: String([1, 2, 4][i]),
            amount_f: [1, 2, 4][i],
            currency: 'USD',
            amount_issuer: USD_ISSUER,
          }),
        ),
      );
      await buildNftAggregates(h, world.native);
      await api.ok('/v2/test-cache/clear', 'result');

      const days = (await api.get(`${path('/stats')}?start=${iso(closeOf(0))}&end=${iso(closeOf(1))}`)).body.days;
      expect(days).toEqual([
        {
          date: `${day}T00:00:00Z`,
          sales_count: 3,
          volume_native: '2.333333',
          avg_price_native: '0.777778',
          min_price_native: '0.333333',
          mints: 2,
          burns: 0,
        },
      ]);
      // the volume of the collection is the same sum, and its sales have the prices
      expect((await api.get(path())).body.collection).toMatchObject({ sales_count: 3, volume_native: '2.333333' });
      expect(((await api.get(path('/sales'))).body.sales as Obj[]).map((s) => s.converted_amount)).toEqual([
        '0.333333',
        '0.666667',
        '1.333333',
      ]);
    } finally {
      await h.close();
    }
  });

  it('answers the coverage of the feature after result: incomplete until the amendment is enabled, and left out of from_ledger_index with no ledger', async () => {
    const { h, api } = await startCase();
    try {
      // an empty database: no ledger, no collection
      const empty = await api.get('/v2/nft_collections');
      expect([empty.status, empty.body]).toEqual([
        200,
        { result: 'success', coverage: { complete: false }, total: 0, count: 0, collections: [] },
      ]);
      expect((await api.get(path())).body).toEqual({ result: 'error', message: 'collection not found' });
      expect((await api.get(path('/nfts'))).status).toBe(404);

      await seedCollection(h);
      await buildNftAggregates(h, world.native);
      await api.ok('/v2/test-cache/clear', 'result');
      const incomplete = await api.get(path());
      expect(incomplete.body.coverage).toEqual({ from_ledger_index: E, complete: false });
      expect(Object.keys(incomplete.body)).toEqual(['result', 'coverage', 'collection']);

      await insertState(h.ch, [
        { ledger_index: E + 1, polled_at: Date.now() / 1000, amendments: [amendmentId(world.amendment)] },
      ]);
      await api.ok('/v2/test-cache/clear', 'result');
      for (const route of [
        '/v2/nft_collections',
        path(),
        path('/nfts'),
        path('/holders'),
        path('/sales'),
        `${path('/stats')}?start=2020-01-01&end=2020-02-01`,
      ]) {
        const res = await api.get(route);
        expect([route, res.status, res.body.coverage]).toEqual([route, 200, { from_ledger_index: E, complete: true }]);
        expect(Object.keys(res.body)[1]).toBe('coverage');
      }
    } finally {
      await h.close();
    }
  });
});
