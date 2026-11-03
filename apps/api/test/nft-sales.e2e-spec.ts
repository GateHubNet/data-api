import { Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, cells, decodeMarker, iso, lines } from './support/amm';
import { csvDisposition } from './support/csv';
import { fixtureSource } from './support/fixtures';
import {
  JPY_ISSUER,
  rateRows,
  ratesOf,
  saleOf,
  syntheticCollections,
  USD_ISSUER,
} from './support/nft-collections-oracle';
import { expectListContract, expectWalk } from './support/nft-lists';
import { fixtureNftEvents, insertNftEvents, nftEventRow } from './support/nfts';
import { compareKeys, Ev, expectOrdered, Obj, Slot, syntheticEvents, WORLDS } from './support/nfts-oracle';
import { innerRead, isPageRead } from './support/plans';

/**
 * `GET /v2/nft_sales` on a real ClickHouse, for each network: the recorded ledgers of the NFT fixtures, the events of the NFT suite
 * and the collections of the collection suite made by hand (their transactions say `synthetic-…`), the sales among them priced in
 * the native currency, in an issued currency with a rate and without, and brokered; a sale written twice, and a sale in a ledger
 * above the committed head. What the route answers is checked against the oracle of the collection suite in plain JavaScript over
 * the events (`support/nft-collections-oracle.ts`), none of it from the code under test.
 */

/** The pinned key order of a sale (written out here once more, apart from the code under test). */
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

/** A marker that is none of ours: not even base64url. */
const BAD_MARKER = '!!!';
/** The marker of a key, written by hand: its values as JSON, in base64url. */
const base64 = (values: unknown[]): string => Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');

describe.each(WORLDS)('GET /v2/nft_sales over the recorded $seed ledgers', (world) => {
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
  const [, , , c3] = hand.keys;

  /** Every sale the route can see (the committed ledgers), in the order of the key. */
  const sales: Ev[] = [...recorded, ...made.rows, ...hand.first, ...hand.second]
    .filter((e) => e.event === 'sale')
    .sort(compareKeys);
  const served = (list: Ev[]): Obj[] => list.map((e) => saleOf(e, rates));
  /** The sale in an issued currency of the recordings: priced in a currency with no rate. */
  const unrated = recorded.find((e) => e.event === 'sale' && e.amount_issuer !== '') as Ev;
  /** The sales priced in the native currency. */
  const inNative = (list: Ev[]): Ev[] => list.filter((e) => e.currency === world.native && e.amount_issuer === '');
  /** The sales priced in an asset. */
  const pricedIn = (currency: string, issuer: string): Ev[] =>
    sales.filter((e) => e.currency === currency && e.amount_issuer === issuer);
  const WINDOW = `start=${iso(slots[0].close)}&end=${iso(slots[slots.length - 1].close)}`;

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: world.seed, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    // the rates the sales are priced with
    await h.ch.insert(Table.NativeRatesDaily, rateRows(hand.rates));
    await insertNftEvents(h, made.rows);
    await insertNftEvents(h, hand.first);
    await insertNftEvents(h, hand.second);
    // a sale in a ledger above the committed head: the ledger is not committed, so the route may not serve it
    await insertNftEvents(h, [
      nftEventRow({
        nft_id: '5'.repeat(64),
        ledger_index: HEAD + 7,
        close_time: slots[slots.length - 1].close + 900,
        tx_index: 1,
        event: 'sale',
        tx_type: xrpl ? 'NFTokenAcceptOffer' : 'URITokenBuy',
        from_account: accountAt(0xa1),
        to_account: accountAt(0xa2),
        amount: '777',
        amount_f: 777,
        currency: world.native,
      }),
    ]);
    // the sales of c3 are written twice, as a re-ingest can leave them: the table has two parts with the same keys
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.NftSales}`);
    await h.ch.command(
      `INSERT INTO ${Table.NftSales} SELECT * FROM ${Table.NftSales} WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32}`,
      { issuer: c3.issuer, taxon_key: c3.taxon_key },
      { settings: { insert_deduplicate: 0 } },
    );
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume', async () => {
    expect(sales.length).toBeGreaterThanOrEqual(8);
    // the native currency, an issued currency with a rate (USD), one without (JPY, the recorded one), a brokered sale
    expect(pricedIn('USD', USD_ISSUER)).toHaveLength(1);
    expect(pricedIn('JPY', JPY_ISSUER)).toHaveLength(1);
    expect(unrated.amount_issuer).not.toBe('');
    expect(inNative(sales).length).toBeGreaterThanOrEqual(5);
    expect(sales.filter((e) => e.broker === accountAt(0x77))).toHaveLength(1);
    // c3's sales are in the table twice, and one sale lies above the head
    const [stored] = await h.ch.query<{ n: string; distinct: string; above: string }>(
      `SELECT count() AS n, uniqExact(ledger_index, tx_index, event_index) AS distinct,
              countIf(ledger_index > {head:UInt32}) AS above FROM ${Table.NftSales}`,
      { head: HEAD },
    );
    expect([Number(stored.n), Number(stored.distinct), Number(stored.above)]).toEqual([
      sales.length + 3 + 1,
      sales.length + 1,
      1,
    ]);
  });

  describe('the sales', () => {
    it('lists every sale oldest first, with descending newest first: the oracle, keys in order, a sale written twice once, none above the head', async () => {
      const up = await get('/v2/nft_sales?limit=1000');
      const down = await get('/v2/nft_sales?limit=1000&descending=true');
      expect([up.status, down.status]).toEqual([200, 200]);
      expect(Object.keys(up.body)).toEqual(['result', 'coverage', 'count', 'sales']);
      expect(up.body.sales).toEqual(served(sales));
      expect(down.body.sales).toEqual(served(sales).reverse());
      expect(up.body.count).toBe(sales.length);
      for (const sale of up.body.sales as Obj[]) expectOrdered(sale, SALE_KEYS, sale.tx_hash);
      // no sale of the ledger above the head, and the three sales of c3 once each
      expect((up.body.sales as Obj[]).map((s) => s.amount)).not.toContain('777');
      expect(
        (up.body.sales as Obj[]).filter((s) => s.issuer === c3.issuer && (!xrpl || s.taxon === c3.taxon_key)),
      ).toHaveLength(3);
      // the sales are in the order of the ledgers, and ascending is the default
      const ledgers = (up.body.sales as Obj[]).map((s) => s.ledger_index as number);
      expect(ledgers).toEqual([...ledgers].sort((a, b) => a - b));
      expect((await get('/v2/nft_sales?limit=1000&descending=false')).body.sales).toEqual(up.body.sales);
    });

    it('a sale has converted_amount where its price has a rate that day, a brokered one its broker, fee and royalty', async () => {
      const list = (await get('/v2/nft_sales?limit=1000')).body.sales as Obj[];
      const at = (e: Ev): Obj =>
        list.find(
          (s) => s.ledger_index === e.ledger_index && s.tx_index === e.tx_index && s.event_index === e.event_index,
        ) as Obj;
      // native: its own price
      const native = at(inNative(sales)[0]);
      expect(native.converted_amount).toBe(native.amount);
      expect(native).not.toHaveProperty('amount_issuer');
      expect(native.mode).toBe('direct');
      // USD at a rate of 4: 40 USD are 10 coins
      expect(at(pricedIn('USD', USD_ISSUER)[0])).toMatchObject({
        amount: '40',
        currency: 'USD',
        amount_issuer: USD_ISSUER,
        converted_amount: '10',
        mode: 'direct',
      });
      // an unrated issued sale has no converted_amount (JPY of c3, and the recorded one): the other keys stay
      for (const e of [pricedIn('JPY', JPY_ISSUER)[0], unrated]) {
        const sale = at(e);
        expect([e.currency, sale.amount_issuer]).toEqual([e.currency, e.amount_issuer]);
        expect(sale).not.toHaveProperty('converted_amount');
        expectOrdered(sale, SALE_KEYS, e.currency);
      }
      // brokered: mode, broker, broker_fee and royalty_est (a URIToken has no royalty); the recorded brokered sale of the
      // XRPL is one too
      for (const e of sales.filter((e) => e.broker !== '')) expect(at(e).mode).toBe('brokered');
      for (const e of sales.filter((e) => e.broker === '')) expect(at(e).mode).toBe('direct');
      const brokered = at(sales.find((e) => e.broker === accountAt(0x77)) as Ev);
      expect(brokered).toMatchObject({
        mode: 'brokered',
        broker: accountAt(0x77),
        broker_fee: '0.5',
        converted_amount: '3',
      });
      if (xrpl) expect(brokered.royalty_est).toBe('0.25');
      else expect(brokered).not.toHaveProperty('royalty_est');
      expect(Object.keys(brokered)).toEqual(
        SALE_KEYS.filter((k) => !(k === 'amount_issuer' || (!xrpl && ['taxon', 'serial', 'royalty_est'].includes(k)))),
      );
      // an XRPL sale has the taxon and the serial of its id, a Xahau one has none
      expect([typeof native.taxon, typeof native.serial]).toEqual(
        xrpl ? ['number', 'number'] : ['undefined', 'undefined'],
      );
    });

    it('start and end are dates: the sales of the ledgers that closed in the window, the second each names included', async () => {
      const ledgers = [...new Set(sales.map((e) => e.ledger_index))];
      expect(ledgers.length).toBeGreaterThanOrEqual(3);
      const closeOf = (ledger: number): number => (slots.find((s) => s.index === ledger) as Slot).close;
      const served = (query: string): Promise<unknown[]> =>
        get(`/v2/nft_sales?${query}&limit=1000`).then((r) => (r.body.sales as Obj[]).map((s) => s.ledger_index));
      const [a, b] = [ledgers[1], ledgers[2]];
      const inWindow = (from: number, to: number): number[] =>
        sales.filter((e) => e.close_time >= from && e.close_time <= to).map((e) => e.ledger_index);
      expect(await served(`start=${iso(closeOf(a))}&end=${iso(closeOf(b))}`)).toEqual(inWindow(closeOf(a), closeOf(b)));
      expect(await served(`start=${iso(closeOf(a))}`)).toEqual(inWindow(closeOf(a), Infinity));
      expect(await served(`end=${iso(closeOf(a))}`)).toEqual(inWindow(0, closeOf(a)));
      expect(await served(`start=${iso(closeOf(a) + 1)}&descending=true`)).toEqual(
        inWindow(closeOf(a) + 1, Infinity).reverse(),
      );
      // the whole seed
      expect(await served(WINDOW)).toEqual(sales.map((e) => e.ledger_index));
      // a window with no ledger in it, and one before the first, are empty lists with the coverage
      const empty = await get('/v2/nft_sales?start=2001-01-01&end=2001-01-02');
      expect([empty.status, empty.body.count, empty.body.sales]).toEqual([200, 0, []]);
      expect(empty.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
      expect(Object.keys(empty.body)).toEqual(['result', 'coverage', 'count', 'sales']);
    });

    it('pages with the marker (ledger_index, tx_index, event_index), both ways, with a window and a currency', async () => {
      await expectWalk(api, '/v2/nft_sales', 'sales', served(sales), [1, 2, 3, 7]);
      await expectWalk(api, '/v2/nft_sales?descending=true', 'sales', served(sales).reverse(), [1, 3]);
      const from = sales[2].close_time;
      await expectWalk(
        api,
        `/v2/nft_sales?start=${iso(from)}`,
        'sales',
        served(sales.filter((e) => e.close_time >= from)),
        [1, 3],
      );
      // the marker is the key of the last sale of the page
      const page = await get('/v2/nft_sales?limit=2');
      const last = sales[1];
      expect(decodeMarker(page.body.marker)).toEqual([last.ledger_index, last.tx_index, last.event_index]);
      expect(Object.keys(page.body)).toEqual(['result', 'coverage', 'count', 'marker', 'sales']);
      // a page cut inside the duplicates (c3's sales are in the table twice) neither repeats nor skips a sale
      await expectWalk(
        api,
        `/v2/nft_sales?currency=JPY%2B${JPY_ISSUER}`,
        'sales',
        served(pricedIn('JPY', JPY_ISSUER)),
        [1],
      );
      const tied = sales.filter((e) => e.issuer === c3.issuer && e.taxon_key === c3.taxon_key);
      expect(tied).toHaveLength(3);
      for (const descending of [false, true]) {
        const want = served(
          sales.filter((e) => e.close_time >= tied[0].close_time && e.close_time <= tied[2].close_time),
        );
        await expectWalk(
          api,
          `/v2/nft_sales?start=${iso(tied[0].close_time)}&end=${iso(tied[2].close_time)}&descending=${descending}`,
          'sales',
          descending ? [...want].reverse() : want,
          [1, 2],
        );
      }
    });
  });

  describe('currency', () => {
    const base = (currency: string): string => `/v2/nft_sales?currency=${currency}`;
    const list = async (currency: string): Promise<Obj[]> => {
      const res = await get(`${base(currency)}&limit=1000`);
      expect([currency, res.status]).toEqual([currency, 200]);
      return res.body.sales as Obj[];
    };
    const answer = async (query: string): Promise<[number, string]> => {
      const res = await get(`/v2/nft_sales?${query}`);
      return [res.status, res.body.message];
    };

    it('the native currency alone: the sales priced in it, and none of an issued currency of the same code', async () => {
      const native = served(inNative(sales));
      expect(native.length).toBeGreaterThanOrEqual(5);
      expect(await list(world.native)).toEqual(native);
      expect(await list(world.native.toLowerCase())).toEqual(native);
      // (descending reverses the filtered list)
      expect((await get(`${base(world.native)}&descending=true&limit=1000`)).body.sales).toEqual([...native].reverse());
      // the other network's native currency is an issued currency here, and needs an issuer
      const other = xrpl ? 'XAH' : 'XRP';
      expect(await answer(`currency=${other}`)).toEqual([400, 'issuer is required']);
      // ... with one it is a currency like another: nothing is priced in it
      expect(await list(`${other}%2B${USD_ISSUER}`)).toEqual([]);
    });

    it('an MPT as parseAsset reads it: no sale is priced in one, so an empty list, not a 400 (ruling C16)', async () => {
      const id = '0598F6E09E30A809E63A1F02DE789586D2F4FDA9EF5200E3';
      expect(await list(id.toLowerCase())).toEqual([]);
      expect(await answer(`currency=${id}%2B${USD_ISSUER}`)).toEqual([400, 'issuer does not match mpt issuance']);
    });

    it('CUR+issuer, as /v2/payments/{currency} reads it: %2B, a + that arrived as a space, | and . match the same sales', async () => {
      const usd = served(pricedIn('USD', USD_ISSUER));
      expect(usd).toHaveLength(1);
      expect(usd[0]).toMatchObject({ converted_amount: '10' });
      for (const form of [
        `USD%2B${USD_ISSUER}`,
        // a + in a query string is a space: read as the separator it stands for
        `USD+${USD_ISSUER}`,
        `USD%20${USD_ISSUER}`,
        `usd%2B${USD_ISSUER}`,
        `USD%7C${USD_ISSUER}`,
        `USD.${USD_ISSUER}`,
      ]) {
        expect([form, await list(form)]).toEqual([form, usd]);
      }
      // the unrated currencies are found too: they just have no converted price
      expect(await list(`JPY+${JPY_ISSUER}`)).toEqual(served(pricedIn('JPY', JPY_ISSUER)));
      expect(await list(`${unrated.currency}%2B${unrated.amount_issuer}`)).toEqual(
        served(pricedIn(unrated.currency, unrated.amount_issuer)),
      );
      // a currency of another issuer is another currency
      expect(await list(`USD%2B${JPY_ISSUER}`)).toEqual([]);
      // an empty currency is no filter
      expect(await list('')).toEqual(served(sales));
    });

    it('is a condition of the read that is capped, so a page of a rare currency is full while there is a next one', async () => {
      // the native currency is most of the sales: a page of one USD sale, among the others, is found
      const usd = served(pricedIn('USD', USD_ISSUER));
      await expectWalk(api, base(`USD%2B${USD_ISSUER}`), 'sales', usd, [1]);
      const spy = jest.spyOn(h.ch, 'query');
      await get(base(`USD%2B${USD_ISSUER}`));
      const reads = spy.mock.calls.filter(([sql]) => isPageRead(String(sql)));
      expect(reads).toHaveLength(1);
      const [sql, params] = reads[0] as [string, Record<string, unknown>];
      expect(innerRead(sql)).toContain('currency = {currency:String} AND amount_issuer = {amount_issuer:String}');
      expect(params).toMatchObject({ currency: 'USD', amount_issuer: USD_ISSUER });
      expect(sql).not.toMatch(/\bFINAL\b/i);
      // the native currency has no issuer: the filter says so
      spy.mockClear();
      await get(base(world.native));
      const [, nativeParams] = spy.mock.calls.find(([text]) => isPageRead(String(text))) as [
        string,
        Record<string, unknown>,
      ];
      expect(nativeParams).toMatchObject({ currency: world.native, amount_issuer: '' });
    });

    it('answers 400 for a currency that is none, with the messages of /v2/payments/{currency}', async () => {
      expect(await answer('currency=USD')).toEqual([400, 'issuer is required']);
      expect(await answer(`currency=USD%2Bxyz`)).toEqual([400, 'invalid issuer address']);
      expect(await answer(`currency=%2B${USD_ISSUER}`)).toEqual([400, 'currency is required']);
      expect(await answer(`currency=${world.native}%2B${USD_ISSUER}`)).toEqual([
        400,
        `${world.native} cannot have an issuer`,
      ]);
      // (a space is read as the + that it stands for, whichever side of the code it is on)
      expect(await answer(`currency=USD%20xyz`)).toEqual([400, 'invalid issuer address']);
      expect(await answer(`currency=%20${USD_ISSUER}`)).toEqual([400, 'currency is required']);
      // the checks come in the order of /v2/payments/{currency}: the issuer, start, end, the rest of the currency, the marker
      expect(await answer(`currency=USD%2Bxyz&start=x&end=x&marker=${BAD_MARKER}`)).toEqual([
        400,
        'invalid issuer address',
      ]);
      expect(await answer(`currency=USD&start=x&end=x&marker=${BAD_MARKER}`)).toEqual([
        400,
        'invalid start date format',
      ]);
      expect(await answer(`currency=USD&end=x&marker=${BAD_MARKER}`)).toEqual([400, 'invalid end date format']);
      expect(await answer(`currency=USD&marker=${BAD_MARKER}`)).toEqual([400, 'issuer is required']);
      expect(await answer(`start=x&end=x&marker=${BAD_MARKER}`)).toEqual([400, 'invalid start date format']);
      expect(await answer(`end=x&marker=${BAD_MARKER}`)).toEqual([400, 'invalid end date format']);
      expect(await answer(`marker=${BAD_MARKER}`)).toEqual([400, 'invalid marker']);
      // a mistake of the client is answered before any read
      const spy = jest.spyOn(h.ch, 'query');
      await answer('currency=USD&start=x');
      await answer(`marker=${BAD_MARKER}&currency=USD`);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('the contract of the route', () => {
    it('passes the shared list tests: empty, markers concatenate, descending, unknown parameters ignored, CSV and Link, 401', async () => {
      await expectListContract(
        h,
        api,
        {
          name: 'the sales',
          path: '/v2/nft_sales',
          key: 'sales',
          want: served(sales),
          empty: '/v2/nft_sales?start=2001-01-01&end=2001-01-02',
          csvColumns: SALE_KEYS,
          file: 'nft sales',
          descending: true,
        },
        { from_ledger_index: FIRST, complete: false },
      );
      // the same with a currency, which is in the path of the Link and of the CSV
      await expectListContract(
        h,
        api,
        {
          name: 'the sales in the native currency',
          path: `/v2/nft_sales?currency=${world.native}`,
          key: 'sales',
          want: served(inNative(sales)),
          empty: `/v2/nft_sales?currency=USD%2B${JPY_ISSUER}`,
          csvColumns: SALE_KEYS,
          file: 'nft sales',
          descending: true,
        },
        { from_ledger_index: FIRST, complete: false },
      );
    });

    it('the CSV has a cell empty where a sale has no key: a sale with no converted price, in the same columns as the others', async () => {
      const csv = lines((await get('/v2/nft_sales?format=csv&limit=1000')).text).map(cells);
      const converted = csv[0].indexOf('"converted_amount"');
      const empties = csv.slice(1).filter((row) => row[converted] === '""');
      expect(empties).toHaveLength(sales.filter((e) => e.amount_issuer !== '' && !(e.currency === 'USD')).length);
      expect(csv[0]).toHaveLength(SALE_KEYS.length);
      expect((await get('/v2/nft_sales?format=csv')).headers['content-disposition']).toBe(csvDisposition('nft sales'));
      // an error is not a CSV
      const bad = await get('/v2/nft_sales?format=csv&currency=USD');
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'issuer is required' }]);
    });

    it('answers 400 invalid marker for a marker that is none of its own', async () => {
      for (const marker of [
        base64([]),
        base64([1, 2]),
        base64([1, 2, 70_000]),
        base64(['a', 1, 2]),
        base64([-1, 0, 0]),
        base64([null, 1, 2]),
        base64([1, 2, 3, 4]),
        'not base64 !',
      ]) {
        const res = await get(`/v2/nft_sales?marker=${encodeURIComponent(marker)}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
    });

    it('answers a 500 with its own message when the database fails, and leaks nothing', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      const res = await get('/v2/nft_sales');
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve sales' }]);
      expect(JSON.stringify(res.body)).not.toContain('boom');
    });

    it('states the coverage of the feature, the key after result, and not in the CSV', async () => {
      const res = await get('/v2/nft_sales?limit=1');
      expect(Object.keys(res.body).slice(0, 2)).toEqual(['result', 'coverage']);
      expect(res.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
      expect((await get('/v2/nft_sales?format=csv&limit=1')).text).not.toContain('coverage');
    });
  });
});
