import { amendmentId, NativeRatesDailyRow, RATES_DAILY_CONFIG_VERSION, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { cells, decodeMarker, iso, lines } from './support/amm';
import { csvDisposition } from './support/csv';
import { fixtureSource } from './support/fixtures';
import { buildNftAggregates, fixtureNftEvents, insertNftEvents, nftEventRow } from './support/nfts';
import {
  ABOVE,
  ALICE,
  BOB,
  BUSY,
  CAROL,
  compareKeys,
  CUT,
  DAVE,
  DAY,
  Ev,
  eventOf,
  expectOrdered,
  EXPIRED,
  EXPIRED_REMOVED,
  FULL,
  ISSUER,
  nftOf,
  Obj,
  offerOf,
  openOffersOf,
  Slot,
  SYNTHETIC_IDS,
  syntheticEvents,
  synthId,
  TWICE,
  WORLDS,
} from './support/nfts-oracle';
import { insertState, ledgerRow } from './support/validators-seed';

/**
 * `GET /v2/nfts/{nft_id}`, `/history` and `/offers` on a real ClickHouse, for each network: the recorded ledgers of the NFT
 * fixtures (`xrpl-nft`: mints, offers, sales, a burn, a modify; `xahau-uritoken`: mints, sell offers, a buy, burns, a Remit),
 * with the aggregates built over them, and a handful of NFTs made by hand (their transactions say `synthetic-…`) for what the
 * recordings do not hold: an NFT with a whole life across several ledgers, offers that end after the page that lists them,
 * offers that expire, a row written twice and a row above the committed head.
 *
 * What the routes answer is checked against an oracle in plain JavaScript over the events the parser builds
 * (`fixtureNftEvents`) and the events made by hand (both in `support/nfts-oracle.ts`, which the collections suite uses too): the
 * state of an NFT, its events, and its open offers, none of it from the code under test. The times of the points of an NFT are also pinned as text, worked out from the close times of the ledgers.
 */

/** The pinned key orders (written out here once more, apart from the code under test). */
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
const POINT_KEYS = ['ledger_index', 'tx_hash', 'executed_time'];
const MINTED_KEYS = [...POINT_KEYS, 'by', 'to'];
const BURNED_AT_KEYS = [...POINT_KEYS, 'by'];
const LAST_SALE_KEYS = [
  'amount',
  'currency',
  'amount_issuer',
  'converted_amount',
  'ledger_index',
  'tx_hash',
  'executed_time',
];
const EVENT_KEYS = [
  'nft_id',
  'kind',
  'issuer',
  'taxon',
  'serial',
  'ledger_index',
  'tx_index',
  'event_index',
  'tx_hash',
  'tx_type',
  'executed_time',
  'event',
  'account',
  'from',
  'to',
  'offer_id',
  'is_sell_offer',
  'amount',
  'currency',
  'amount_issuer',
  'converted_amount',
  'destination',
  'expiration',
  'broker',
  'broker_fee',
  'royalty_est',
  'removed_by',
  'uri',
];
const OFFER_KEYS = [
  'offer_id',
  'is_sell_offer',
  'owner',
  'amount',
  'currency',
  'amount_issuer',
  'destination',
  'expiration',
  'created_ledger',
  'created_tx_hash',
  'created_time',
];

// =====================================================================================================================

describe.each(WORLDS)('the NFT routes over the recorded $seed ledgers', (world) => {
  const recorded = fixtureNftEvents(world.seed);
  const slots: Slot[] = fixtureSource(world.seed)
    .list()
    .map((l) => ({ index: l.header.ledger_index, close: l.header.close_time }))
    .sort((a, b) => a.index - b.index);
  const FIRST = slots[0].index;
  const HEAD = slots[slots.length - 1].index;
  const made = syntheticEvents(world, slots, HEAD);
  /** The events of every NFT in the order of the index, up to the head: what the routes can see. */
  const byNft = new Map<string, Ev[]>();
  for (const e of [...recorded, ...made.rows].sort(compareKeys)) {
    const list = byNft.get(e.nft_id);
    if (list) list.push(e);
    else byNft.set(e.nft_id, [e]);
  }
  const manifest = JSON.parse(readFileSync(join(world.dir, 'manifest.json'), 'utf8')) as {
    cases: Record<string, { ledger: number; hash: string }>;
  };
  /** The NFT of a recorded case, by the hash of the transaction that is its case. */
  const nftOfCase = (name: string): string => {
    const found = recorded.filter((e) => e.tx_hash === manifest.cases[name].hash);
    expect([name, new Set(found.map((e) => e.nft_id)).size >= 1]).toEqual([name, true]);
    return found[0].nft_id;
  };

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  /** The events of the NFT up to the head: the oracle's input. */
  const eventsOf = (id: string): Ev[] => byNft.get(id) as Ev[];
  const coverageOf = (id: string): Obj => ({
    from_ledger_index: FIRST,
    complete: eventsOf(id)[0].event === 'mint',
  });

  beforeAll(async () => {
    h = await startHarness({
      seed: world.seed,
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    api = await h.api();
    get = api.get;
    await insertNftEvents(h, made.rows);
    // a row above the committed head: the ledger is not committed, so none of the routes may serve it
    await insertNftEvents(h, made.above);
    // TWICE is written twice, as a re-ingest can leave it, each time as a part of its own
    for (const table of [Table.NftEvents, Table.CollectionNftEvents]) {
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
      await h.ch.command(
        `INSERT INTO ${table} SELECT * FROM ${table} WHERE nft_id = {id:String}`,
        { id: TWICE },
        { settings: { insert_deduplicate: 0 } },
      );
    }
    await buildNftAggregates(h, world.native);
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume', async () => {
    expect(slots.length).toBeGreaterThanOrEqual(5);
    expect(byNft.size).toBeGreaterThan(SYNTHETIC_IDS.length);
    // every NFT of the seed and of the hand has events, none above the head
    for (const [id, list] of byNft) expect([id, list.every((e) => e.ledger_index <= HEAD)]).toEqual([id, true]);
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.NftEvents} WHERE ledger_index > {head:UInt32}`,
      {
        head: HEAD,
      },
    );
    expect(Number(n)).toBe(made.above.length);
    // the recorded cases the tests use are there
    for (const name of Object.keys(manifest.cases)) expect(manifest.cases[name].hash).toMatch(/^[0-9A-F]{64}$/);
  });

  // -- the detail -----------------------------------------------------------------------------------------------------

  describe('GET /v2/nfts/{nft_id}', () => {
    it('serves the detail folded from the events, keys in NFT_KEYS order: every NFT of the seed and of the hand, as the oracle has it', async () => {
      for (const [id, list] of byNft) {
        const res = await get(`/v2/nfts/${id}`);
        expect([id, res.status]).toEqual([id, 200]);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'nft']);
        expect(res.body.result).toBe('success');
        expect([id, res.body.nft]).toEqual([id, nftOf(list)]);
        expectOrdered(res.body.nft, NFT_KEYS, id);
        expect([id, res.body.coverage]).toEqual([id, coverageOf(id)]);
        expect(Object.keys(res.body.coverage)).toEqual(['from_ledger_index', 'complete']);
      }
    });

    it('a lower-case id is the same NFT', async () => {
      const id = nftOfCase(world.kind === 'nftoken' ? 'mint' : 'uritoken_mint');
      const [upper, lower] = [await get(`/v2/nfts/${id}`), await get(`/v2/nfts/${id.toLowerCase()}`)];
      expect([lower.status, lower.body]).toEqual([200, upper.body]);
    });

    it('serves the facts of an NFT with its owner, mint and sales: whole, with the times as text and the price in the native currency', async () => {
      const full = (await get(`/v2/nfts/${FULL}`)).body.nft as Obj;
      const [m, s1] = [eventsOf(FULL)[0], eventsOf(FULL).find((e) => e.event === 'sale')!];
      const lastSale = eventsOf(FULL)
        .filter((e) => e.event === 'sale')
        .pop()!;
      expect(full.sale_count).toBe(world.kind === 'nftoken' ? 2 : 1);
      expect(full.minted).toEqual({
        ledger_index: m.ledger_index,
        tx_hash: m.tx_hash,
        executed_time: iso(m.close_time),
        by: m.account,
        to: ALICE,
      });
      expect(full.owner).toBe(world.kind === 'nftoken' ? CAROL : BOB);
      expect(full.last_sale).toEqual({
        amount: lastSale.amount,
        currency: world.native,
        converted_amount: lastSale.amount,
        ledger_index: lastSale.ledger_index,
        tx_hash: lastSale.tx_hash,
        executed_time: iso(lastSale.close_time),
      });
      expect(Object.keys(full.last_sale as Obj)).toEqual(LAST_SALE_KEYS.filter((k) => k !== 'amount_issuer'));
      expect(s1.ledger_index).toBe(slots[1].index);
      expect(full.burned).toBe(false);
      expect(full).not.toHaveProperty('burned_at');
    });

    it('writes executed_time of owner_since, minted, burned_at and last_sale exactly: seconds, UTC, as the ledger closed', async () => {
      // the close times of the recorded ledgers, worked out by hand from the ledgers' headers
      const cases =
        world.kind === 'nftoken'
          ? {
              sold: { id: 'sale_by_sell_offer', time: '2026-10-24T16:08:12Z', ledger: 107874617 },
              minted: { id: 'mint', time: '2026-10-24T20:42:50Z', ledger: 107878781 },
              burned: { id: 'burn', time: '2026-10-25T02:00:52Z', ledger: 107883610 },
            }
          : {
              sold: { id: 'uritoken_buy_above_ask', time: '2026-10-24T15:36:02Z', ledger: 26763778 },
              minted: { id: 'remit_mint', time: '2026-10-21T13:29:11Z', ledger: 26689211 },
              burned: { id: 'uritoken_burn_with_offer', time: '2026-10-24T20:35:00Z', ledger: 26768773 },
            };
      const sold = (await get(`/v2/nfts/${nftOfCase(cases.sold.id)}`)).body.nft as Obj;
      expect((sold.owner_since as Obj).executed_time).toBe(cases.sold.time);
      expect((sold.owner_since as Obj).ledger_index).toBe(cases.sold.ledger);
      expect((sold.last_sale as Obj).executed_time).toBe(cases.sold.time);
      expect((sold.last_sale as Obj).ledger_index).toBe(cases.sold.ledger);
      const minted = (await get(`/v2/nfts/${nftOfCase(cases.minted.id)}`)).body.nft as Obj;
      expect((minted.minted as Obj).executed_time).toBe(cases.minted.time);
      expect((minted.minted as Obj).ledger_index).toBe(cases.minted.ledger);
      const burned = (await get(`/v2/nfts/${nftOfCase(cases.burned.id)}`)).body.nft as Obj;
      expect((burned.burned_at as Obj).executed_time).toBe(cases.burned.time);
      expect((burned.burned_at as Obj).ledger_index).toBe(cases.burned.ledger);
      for (const point of [sold.owner_since, sold.last_sale, minted.minted, burned.burned_at] as Obj[]) {
        expect(point.executed_time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        expect(point.tx_hash).toMatch(/^[0-9A-F]{64}$/);
      }
    });

    it('a burned NFT has burned true, burned_at and no owner', async () => {
      const id = nftOfCase(world.kind === 'nftoken' ? 'burn' : 'uritoken_burn_with_offer');
      const nft = (await get(`/v2/nfts/${id}`)).body.nft as Obj;
      expect(nft.burned).toBe(true);
      expect(nft).not.toHaveProperty('owner');
      expect(nft).not.toHaveProperty('owner_since');
      const burnedAt = nft.burned_at as Obj;
      expect(Object.keys(burnedAt)).toEqual(BURNED_AT_KEYS);
      expect(burnedAt.by).toBe(eventsOf(id).find((e) => e.event === 'burn')!.account);
      expectOrdered(nft, NFT_KEYS);
    });

    it('serves an NFT whose mint is not indexed, with its own coverage incomplete', async () => {
      // the NFT of a sell offer made in a recorded ledger: the index has the offer and not its mint
      const id = nftOfCase(world.kind === 'nftoken' ? 'sell_offer_create' : 'uritoken_sell_offer_create');
      const res = await get(`/v2/nfts/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.nft).not.toHaveProperty('owner');
      expect(res.body.nft).not.toHaveProperty('minted');
      expect(res.body.nft).toMatchObject({ burned: false, sale_count: 0 });
      expect(res.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
    });

    it("per NFT, coverage is complete when its mint is indexed though the feature's is not", async () => {
      const minted = nftOfCase(world.kind === 'nftoken' ? 'mint' : 'uritoken_mint');
      const unminted = nftOfCase(world.kind === 'nftoken' ? 'sell_offer_create' : 'uritoken_sell_offer_create');
      const [withMint, without] = [await get(`/v2/nfts/${minted}`), await get(`/v2/nfts/${unminted}`)];
      expect(withMint.body.coverage).toEqual({ from_ledger_index: FIRST, complete: true });
      expect(without.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
      // and the same on the history and the offers
      for (const route of ['history', 'offers']) {
        expect((await get(`/v2/nfts/${minted}/${route}`)).body.coverage).toEqual({
          from_ledger_index: FIRST,
          complete: true,
        });
        expect((await get(`/v2/nfts/${unminted}/${route}`)).body.coverage).toEqual({
          from_ledger_index: FIRST,
          complete: false,
        });
      }
    });

    if (world.kind === 'uritoken') {
      it('an NFT burned and minted again is whole again: owned, not burned, the newest mint', async () => {
        // the id of a URIToken follows the issuer and the URI: the recorded burn and the mint that comes after it are one id
        const id = nftOfCase('uritoken_remint');
        const events = eventsOf(id);
        expect(events.map((e) => e.event)).toEqual(['burn', 'mint']);
        const nft = (await get(`/v2/nfts/${id}`)).body.nft as Obj;
        expect(nft.burned).toBe(false);
        expect(nft).not.toHaveProperty('burned_at');
        expect(nft.owner).toBe(events[1].to_account);
        expect((nft.minted as Obj).ledger_index).toBe(events[1].ledger_index);
        // its first event is a burn: the mint of the first life is not indexed
        expect((await get(`/v2/nfts/${id}`)).body.coverage.complete).toBe(false);
      });
    }

    it('a transfer with no price moves the NFT and is no sale; an NFT of Xahau has a digest, and an NFT of XRPL a taxon and a fee', async () => {
      const moved = nftOfCase(world.kind === 'nftoken' ? 'transfer_zero_amount' : 'remit_transfer');
      const nft = (await get(`/v2/nfts/${moved}`)).body.nft as Obj;
      expect(nft.sale_count).toBe(0);
      expect(nft).not.toHaveProperty('last_sale');
      expect(nft.owner).toBe(eventsOf(moved).find((e) => e.event === 'transfer')!.to_account);
      if (world.kind === 'nftoken') {
        expect(nft).toMatchObject({ kind: 'nftoken', taxon: 2, serial: 95942324, transfer_fee: 50000, flags: 24 });
      } else {
        expect(nft).toMatchObject({ kind: 'uritoken', digest: eventsOf(moved).find((e) => e.digest !== '')!.digest });
        for (const key of ['taxon', 'serial', 'transfer_fee']) expect(nft).not.toHaveProperty(key);
      }
    });

    it('answers 404 nft not found for an id with no event, and for the id of the other network', async () => {
      const other = fixtureNftEvents(world.seed === 'xrpl-nft' ? 'xahau-uritoken' : 'xrpl-nft')[0].nft_id;
      for (const id of [synthId(0xdead), 'F'.repeat(64), other, ABOVE, other.toLowerCase()]) {
        for (const route of ['', '/history', '/offers']) {
          const res = await get(`/v2/nfts/${id}${route}`);
          expect([id, route, res.status, res.body]).toEqual([
            id,
            route,
            404,
            { result: 'error', message: 'nft not found' },
          ]);
        }
      }
    });

    it('agrees with the nfts rows the aggregator job wrote, for every NFT of the seed that has one', async () => {
      const rows = await h.ch.query<Obj>(
        `SELECT nft_id, owner, burned, sale_count, minted_ledger, last_sale_ledger, last_sale_amount, last_sale_currency, uri
           FROM ${Table.Nfts} ORDER BY nft_id, version DESC LIMIT 1 BY nft_id`,
      );
      expect(rows).toHaveLength(byNft.size);
      for (const row of rows) {
        const nft = (await get(`/v2/nfts/${row.nft_id}`)).body.nft as Obj;
        expect([row.nft_id, row.owner === '' ? undefined : row.owner]).toEqual([row.nft_id, nft.owner]);
        expect([row.nft_id, Number(row.burned) === 1]).toEqual([row.nft_id, nft.burned]);
        expect([row.nft_id, Number(row.sale_count)]).toEqual([row.nft_id, nft.sale_count]);
        expect([row.nft_id, row.minted_ledger === null ? undefined : Number(row.minted_ledger)]).toEqual([
          row.nft_id,
          (nft.minted as Obj | undefined)?.ledger_index,
        ]);
        expect([row.nft_id, row.last_sale_ledger === null ? undefined : Number(row.last_sale_ledger)]).toEqual([
          row.nft_id,
          (nft.last_sale as Obj | undefined)?.ledger_index,
        ]);
        expect([row.nft_id, row.uri === '' ? undefined : row.uri]).toEqual([row.nft_id, nft.uri]);
      }
    });

    it('never serves an event above the committed head: the detail of CUT is as of the head', async () => {
      const nft = (await get(`/v2/nfts/${CUT}`)).body.nft as Obj;
      expect(nft.owner).toBe(ALICE);
      expect(nft).toMatchObject({ sale_count: 0 });
      expect(((await get(`/v2/nfts/${CUT}/history`)).body.events as Obj[]).map((e) => e.event)).toEqual(['mint']);
    });
  });

  // -- the history ----------------------------------------------------------------------------------------------------

  describe('GET /v2/nfts/{nft_id}/history', () => {
    it('serves the events of every NFT as the oracle has them, oldest first, in the pinned key order', async () => {
      for (const [id, list] of byNft) {
        const res = await get(`/v2/nfts/${id}/history`);
        expect([id, res.status]).toEqual([id, 200]);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'events']);
        expect(res.body.count).toBe(list.length);
        expect([id, res.body.events]).toEqual([id, list.map((e) => eventOf(e))]);
        expectOrdered(res.body.events[0], EVENT_KEYS, id);
        expect([id, res.body.coverage]).toEqual([id, coverageOf(id)]);
      }
    });

    it('is newest first with descending=true: the same events the other way round', async () => {
      for (const id of [FULL, BUSY, TWICE, ...[...byNft.keys()].filter((k) => eventsOf(k).length > 2).slice(0, 5)]) {
        const asc = await get(`/v2/nfts/${id}/history?descending=false`);
        const desc = await get(`/v2/nfts/${id}/history?descending=true`);
        expect(asc.body.events).toEqual(eventsOf(id).map((e) => eventOf(e)));
        expect([id, desc.body.events]).toEqual([id, [...eventsOf(id)].reverse().map((e) => eventOf(e))]);
      }
    });

    it('writes the events of an offer and a sale with the keys they have, is_sell_offer a boolean, royalty_est as the parser has it', async () => {
      const events = (await get(`/v2/nfts/${FULL}/history`)).body.events as Obj[];
      const offerEvent = events.find((e) => e.event === 'offer_create')!;
      expect(offerEvent.is_sell_offer).toBe(true);
      expect(offerEvent).toMatchObject({ amount: '10', currency: world.native, destination: BOB });
      expect(offerEvent.expiration).toBe(iso(slots[0].close + 7 * DAY));
      expect(events.find((e) => e.event === 'mint')).not.toHaveProperty('is_sell_offer');
      const sale = events.find((e) => e.event === 'sale')!;
      if (world.kind === 'nftoken') expect(sale.royalty_est).toBe('0.5');
      else expect(sale).not.toHaveProperty('royalty_est');
      // the sale of the recorded brokered case: its broker, the cut, the royalty of the rest
      if (world.kind === 'nftoken') {
        const id = nftOfCase('brokered_sale_royalty');
        const brokered = ((await get(`/v2/nfts/${id}/history?event=sale`)).body.events as Obj[])[0];
        expect(brokered).toMatchObject({
          broker: 'rpx9JThQ2y37FaGeeJP7PXDUVEXY3PHZSC',
          broker_fee: '2.3835',
          royalty_est: '4.428495',
        });
        expect(brokered.is_sell_offer).toBe(true);
      }
    });

    it('the event filter keeps the events of the kinds named, in the order of the list, and any case or member that is none is a 400', async () => {
      const all = eventsOf(FULL);
      const kinds = (path: string): Promise<unknown[]> =>
        get(path).then((r) => (r.body.events as Obj[]).map((e) => e.event));
      expect(await kinds(`/v2/nfts/${FULL}/history?event=sale`)).toEqual([
        'sale',
        ...(world.kind === 'nftoken' ? ['sale'] : []),
      ]);
      expect(await kinds(`/v2/nfts/${FULL}/history?event=mint,sale`)).toEqual(
        all.filter((e) => e.event === 'mint' || e.event === 'sale').map((e) => e.event),
      );
      expect(await kinds(`/v2/nfts/${FULL}/history?event=sale,mint`)).toEqual(
        all.filter((e) => e.event === 'mint' || e.event === 'sale').map((e) => e.event),
      );
      expect(
        await kinds(`/v2/nfts/${FULL}/history?event=offer_create,offer_cancel,offer_removed&descending=true`),
      ).toEqual(
        all
          .filter((e) => e.event.startsWith('offer_'))
          .reverse()
          .map((e) => e.event),
      );
      expect(await kinds(`/v2/nfts/${FULL}/history?event=burn`)).toEqual([]);
      expect(await kinds(`/v2/nfts/${FULL}/history?event=`)).toEqual(all.map((e) => e.event));
      for (const event of ['nope', 'sale,nope', 'SALE', 'sale,', 'sale, mint']) {
        const res = await get(`/v2/nfts/${FULL}/history?event=${encodeURIComponent(event)}`);
        expect([event, res.status, res.body]).toEqual([event, 400, { result: 'error', message: 'invalid event' }]);
      }
    });

    it('start and end are dates: the events of the ledgers that closed in the window, the second each names included', async () => {
      const [l0, l1, l2, l3] = slots;
      const key = (e: Ev): unknown[] => [e.ledger_index, e.tx_index, e.event_index];
      const served = (path: string): Promise<unknown[]> =>
        get(path).then((r) => (r.body.events as Obj[]).map((e) => [e.ledger_index, e.tx_index, e.event_index]));
      const among = (from: number, to: number): unknown[] =>
        eventsOf(FULL)
          .filter((e) => e.ledger_index >= from && e.ledger_index <= to)
          .map(key);
      // every ledger of the window closed in it: from the close of l1 to the close of l2, both seconds included
      expect(await served(`/v2/nfts/${FULL}/history?start=${iso(l1.close)}&end=${iso(l2.close)}`)).toEqual(
        among(l1.index, l2.index),
      );
      expect(await served(`/v2/nfts/${FULL}/history?start=${iso(l2.close)}`)).toEqual(among(l2.index, HEAD));
      expect(await served(`/v2/nfts/${FULL}/history?end=${iso(l1.close)}`)).toEqual(among(FIRST, l1.index));
      expect(
        await served(`/v2/nfts/${FULL}/history?start=${iso(l1.close)}&end=${iso(l3.close)}&descending=true`),
      ).toEqual(among(l1.index, l3.index).reverse());
      // a start in the middle of a ledger's second is that second; one second after it leaves the ledger out
      expect(await served(`/v2/nfts/${FULL}/history?start=${iso(l1.close + 1)}&end=${iso(l2.close)}`)).toEqual(
        among(l2.index, l2.index),
      );
      // a window with no ledger in it, and one before the first, are empty lists
      expect(await served(`/v2/nfts/${FULL}/history?start=${iso(l1.close + 1)}&end=${iso(l2.close - 1)}`)).toEqual([]);
      const empty = await get(`/v2/nfts/${FULL}/history?start=2001-01-01&end=2001-01-02`);
      expect([empty.status, empty.body.count, empty.body.events]).toEqual([200, 0, []]);
      expect(empty.body.coverage).toEqual(coverageOf(FULL));
      expect(Object.keys(empty.body)).toEqual(['result', 'coverage', 'count', 'events']);
      // the dates of an NFT whose events are in one ledger only
      const one = eventsOf(nftOfCase(world.kind === 'nftoken' ? 'mint' : 'uritoken_mint'));
      const inside = await get(
        `/v2/nfts/${one[0].nft_id}/history?start=${iso(one[0].close_time)}&end=${iso(one[0].close_time)}`,
      );
      expect(inside.body.events).toHaveLength(one.length);
      expect(l0.index).toBe(FIRST);
    });

    it('pages with the marker (ledger_index, tx_index, event_index): pages of 1, 2 and 3 concatenate to the whole, both ways', async () => {
      for (const id of [FULL, BUSY, TWICE]) {
        const want = eventsOf(id).map((e) => eventOf(e));
        for (const descending of [false, true]) {
          for (const limit of [1, 2, 3, 7]) {
            const walked = await api.pages<{ events: Obj[]; marker?: string; count: number }>(
              `/v2/nfts/${id}/history?descending=${descending}`,
              limit,
              'events',
            );
            expect([id, descending, limit, walked.flatMap((p) => p.events)]).toEqual([
              id,
              descending,
              limit,
              descending ? [...want].reverse() : want,
            ]);
            // every page but the last is full, and the last has no marker
            walked.forEach((p, i) => {
              expect(p.count).toBe(p.events.length);
              if (i < walked.length - 1) expect(p.events).toHaveLength(limit);
              else expect(p.marker).toBeUndefined();
            });
          }
        }
      }
      // the marker is the base64url of the key of the last event of the page
      const page = await get(`/v2/nfts/${FULL}/history?limit=2`);
      const last = eventsOf(FULL)[1];
      expect(decodeMarker(page.body.marker)).toEqual([last.ledger_index, last.tx_index, last.event_index]);
      expect(Object.keys(page.body)).toEqual(['result', 'coverage', 'count', 'marker', 'events']);
    });

    it('a filter is applied inside the read: the pages of a walk by the one event in seven are full', async () => {
      const rare = world.kind === 'nftoken' ? 'modify' : 'offer_cancel';
      const want = eventsOf(BUSY).filter((e) => e.event === rare);
      expect(want.length).toBe(2);
      for (const descending of [false, true]) {
        const walked = await api.pages<{ events: Obj[]; marker?: string }>(
          `/v2/nfts/${BUSY}/history?event=${rare}&descending=${descending}`,
          1,
          'events',
        );
        expect(walked.map((p) => p.events.length)).toEqual([1, 1]);
        expect(walked.flatMap((p) => p.events)).toEqual(
          (descending ? [...want].reverse() : want).map((e) => eventOf(e)),
        );
      }
      // and with offers around them, a walk of the offers by three has the same pages
      const walked = await api.pages<{ events: Obj[]; marker?: string }>(
        `/v2/nfts/${BUSY}/history?event=offer_create`,
        3,
        'events',
      );
      expect(walked.slice(0, -1).every((p) => p.events.length === 3)).toBe(true);
    });

    it('a row written twice is served once, and a page cut inside the duplicates neither repeats nor skips an event', async () => {
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.NftEvents} WHERE nft_id = {id:String}`,
        { id: TWICE },
      );
      expect(Number(n)).toBe(eventsOf(TWICE).length * 2);
      const want = eventsOf(TWICE).map((e) => eventOf(e));
      expect((await get(`/v2/nfts/${TWICE}/history`)).body.events).toEqual(want);
      for (const limit of [1, 2]) {
        const walked = await api.pages<{ events: Obj[]; marker?: string }>(
          `/v2/nfts/${TWICE}/history`,
          limit,
          'events',
        );
        expect(walked.flatMap((p) => p.events)).toEqual(want);
      }
      const offers = (await get(`/v2/nfts/${TWICE}/offers`)).body.offers as Obj[];
      expect(offers).toEqual(openOffersOf(eventsOf(TWICE)).map(offerOf));
      expect(offers).toHaveLength(1);
    });

    it('sets the Link header on a page with a next one, for JSON and CSV, and none on the last page', async () => {
      const page = await get(`/v2/nfts/${FULL}/history?limit=1&event=mint,sale`);
      const origin = new URL(page.request.url).origin;
      expect(page.headers.link).toBe(
        `<${origin}/v2/nfts/${FULL}/history?limit=1&event=mint,sale&marker=${page.body.marker}>; rel="next"`,
      );
      const csv = await get(`/v2/nfts/${FULL}/history?limit=1&event=mint,sale&format=csv`);
      expect(csv.headers.link).toBe(
        `<${origin}/v2/nfts/${FULL}/history?limit=1&event=mint,sale&format=csv&marker=${page.body.marker}>; rel="next"`,
      );
      expect((await get(`/v2/nfts/${FULL}/history`)).headers.link).toBeUndefined();
      expect((await get(`/v2/nfts/${FULL}/history?format=csv`)).headers.link).toBeUndefined();
    });

    it('format=csv: text/csv named <nft_id> - nft history, one row an event, no coverage, the same columns for every page', async () => {
      const res = await get(`/v2/nfts/${FULL.toLowerCase()}/history?format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${FULL} - nft history`));
      const table = lines(res.text).map(cells);
      expect(table).toHaveLength(1 + eventsOf(FULL).length);
      const header = EVENT_KEYS.map((c) => `"${c}"`);
      expect(table[0]).toEqual(header);
      expect(res.text).not.toContain('coverage');
      expect(res.text).not.toContain('from_ledger_index');
      // a mint has no offer: the columns are there, empty
      const mint = table[1];
      expect(mint[EVENT_KEYS.indexOf('event')]).toBe('"mint"');
      expect(mint[EVENT_KEYS.indexOf('offer_id')]).toBe('""');
      expect(mint[EVENT_KEYS.indexOf('is_sell_offer')]).toBe('""');
      const offerRow = table.find((r) => r[EVENT_KEYS.indexOf('event')] === '"offer_create"')!;
      expect(offerRow[EVENT_KEYS.indexOf('is_sell_offer')]).toBe('"true"');
      // every page of a walk has the same header, whatever its events hold
      let marker: string | undefined;
      let pageNumber = 0;
      do {
        const more = marker ? `&marker=${marker}` : '';
        const part = await get(`/v2/nfts/${FULL}/history?format=csv&limit=2${more}`);
        expect([pageNumber, lines(part.text)[0].split(',')]).toEqual([pageNumber, header]);
        marker = ((await get(`/v2/nfts/${FULL}/history?limit=2${more}`)).body as { marker?: string }).marker;
        pageNumber += 1;
      } while (marker && pageNumber < 20);
      expect(pageNumber).toBe(Math.ceil(eventsOf(FULL).length / 2));
      const empty = await get(`/v2/nfts/${FULL}/history?format=csv&event=burn`);
      expect([empty.status, empty.text]).toEqual([200, '']);
      const bad = await get(`/v2/nfts/${FULL}/history?format=csv&event=nope`);
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid event' }]);
    });

    it('ignores the params it does not know, and limits like the other lists: 200 by default, at most 1000', async () => {
      const want = eventsOf(FULL).map((e) => eventOf(e));
      expect((await get(`/v2/nfts/${FULL}/history?nothing=1&interval=day&type=sell`)).body.events).toEqual(want);
      for (const [limit, count] of [
        ['', want.length],
        ['0', want.length],
        ['-3', want.length],
        ['abc', want.length],
        ['2.9', 2],
        ['1', 1],
        ['5000', want.length],
        ['all', want.length],
      ] as const) {
        const res = await get(`/v2/nfts/${FULL}/history?limit=${limit}`);
        expect([limit, res.status, res.body.count]).toEqual([limit, 200, count]);
      }
    });
  });

  // -- the offers -----------------------------------------------------------------------------------------------------

  describe('GET /v2/nfts/{nft_id}/offers', () => {
    it('serves the open offers of every NFT as the oracle has them, newest first, in the pinned key order', async () => {
      let total = 0;
      for (const [id, list] of byNft) {
        const res = await get(`/v2/nfts/${id}/offers`);
        expect([id, res.status]).toEqual([id, 200]);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'offers']);
        const want = openOffersOf(list).map(offerOf);
        expect([id, res.body.offers]).toEqual([id, want]);
        expect(res.body.count).toBe(want.length);
        for (const offer of res.body.offers as Obj[]) expectOrdered(offer, OFFER_KEYS, id);
        expect([id, res.body.coverage]).toEqual([id, coverageOf(id)]);
        total += want.length;
      }
      expect(total).toBeGreaterThan(0);
    });

    it('every offer_create of the seed with no later cancel or removal of its offer_id is listed, and no other', async () => {
      // worked out over the whole seed by offer_id, not NFT by NFT: the events as `buildLedgerRows` builds them and as made by hand
      const all = [...recorded, ...made.rows].sort(compareKeys);
      const newest = new Map<string, Ev>();
      for (const e of all) {
        if (e.event === 'offer_create' || e.event === 'offer_cancel' || e.event === 'offer_removed')
          newest.set(e.offer_id, e);
      }
      const open = [...newest.values()].filter((e) => e.event === 'offer_create');
      const served: Obj[] = [];
      for (const id of byNft.keys()) {
        served.push(...(((await get(`/v2/nfts/${id}/offers`)).body.offers as Obj[]) ?? []));
      }
      const key = (o: Obj): string => `${o.created_ledger}:${o.created_tx_hash}:${o.offer_id}`;
      expect(served.map(key).sort()).toEqual(open.map((e) => `${e.ledger_index}:${e.tx_hash}:${e.offer_id}`).sort());
      expect(open.length).toBeGreaterThan(world.kind === 'nftoken' ? 100 : 2);
    });

    it('lists the offer made for FULL that nothing ended, and not the ones that were taken, cancelled or listed before', async () => {
      const offers = (await get(`/v2/nfts/${FULL}/offers`)).body.offers as Obj[];
      if (world.kind === 'nftoken') {
        // newest first: BOB's second listing (it outlived the sale of the NFT), then the buy offer of DAVE
        expect(offers.map((o) => [o.owner, o.is_sell_offer, o.amount])).toEqual([
          [BOB, true, '30'],
          [DAVE, false, '15'],
        ]);
        expect(offers[0].expiration).toBe(iso(slots[4].close + 60));
      } else {
        // the token's one offer was made, cancelled and made again: its newest event is a creation
        expect(offers.map((o) => [o.owner, o.is_sell_offer, o.amount])).toEqual([[BOB, true, '30']]);
        expect(offers[0].offer_id).toBe(FULL);
      }
    });

    it('type=sell and type=buy keep the offers of a side, and an empty type is both', async () => {
      const sellOf = (id: string): Obj[] =>
        openOffersOf(eventsOf(id))
          .filter((e) => e.is_sell_offer === 1)
          .map(offerOf);
      const buyOf = (id: string): Obj[] =>
        openOffersOf(eventsOf(id))
          .filter((e) => e.is_sell_offer === 0)
          .map(offerOf);
      for (const id of [
        FULL,
        BUSY,
        ...[...byNft.keys()].filter((k) => openOffersOf(eventsOf(k)).length > 1).slice(0, 3),
      ]) {
        expect([id, (await get(`/v2/nfts/${id}/offers?type=sell`)).body.offers]).toEqual([id, sellOf(id)]);
        expect([id, (await get(`/v2/nfts/${id}/offers?type=buy`)).body.offers]).toEqual([id, buyOf(id)]);
        expect([id, (await get(`/v2/nfts/${id}/offers?type=`)).body.offers]).toEqual([
          id,
          openOffersOf(eventsOf(id)).map(offerOf),
        ]);
      }
      if (world.kind === 'nftoken') {
        expect(sellOf(FULL)).toHaveLength(1);
        expect(buyOf(FULL)).toHaveLength(1);
        expect(buyOf(BUSY).length).toBeGreaterThan(0);
        expect(sellOf(BUSY).length).toBeGreaterThan(0);
      }
      for (const type of ['both', 'Sell', 'sell,buy']) {
        const res = await get(`/v2/nfts/${FULL}/offers?type=${encodeURIComponent(type)}`);
        expect([type, res.status, res.body]).toEqual([type, 400, { result: 'error', message: 'invalid type' }]);
      }
    });

    it('a NFT with no open offer has an empty list: the offers of a brokered sale are gone, and so are those of a burn', async () => {
      const ids =
        world.kind === 'nftoken'
          ? [nftOfCase('brokered_sale_royalty'), nftOfCase('burn_removes_offers')]
          : [nftOfCase('uritoken_burn_with_offer'), nftOfCase('uritoken_buy_above_ask')];
      for (const id of ids) {
        const res = await get(`/v2/nfts/${id}/offers`);
        expect([id, res.status, res.body.count, res.body.offers]).toEqual([id, 200, 0, []]);
        expect(res.body.coverage).toEqual(coverageOf(id));
      }
    });

    it('lists the offer of an NFT made by an NFTokenMint, and the NFT it is for', async () => {
      const id = nftOfCase(world.kind === 'nftoken' ? 'mint_with_offer' : 'uritoken_sell_offer_create');
      const offers = (await get(`/v2/nfts/${id}/offers`)).body.offers as Obj[];
      expect(offers).toEqual(openOffersOf(eventsOf(id)).map(offerOf));
      expect(offers).toHaveLength(1);
      expect(offers[0].is_sell_offer).toBe(true);
    });

    if (world.kind === 'nftoken') {
      it('an expired offer is listed until it is removed', async () => {
        const expired = (await get(`/v2/nfts/${EXPIRED}/offers`)).body.offers as Obj[];
        expect(expired).toHaveLength(1);
        // it expired long before the committed head closed
        const head = slots[slots.length - 1].close;
        expect(Date.parse(expired[0].expiration as string) / 1000).toBeLessThan(head);
        expect(expired[0].expiration).toBe(iso(slots[0].close + 60));
        // the offer that another transaction cleaned up is gone
        const removed = await get(`/v2/nfts/${EXPIRED_REMOVED}/offers`);
        expect([removed.status, removed.body.offers]).toEqual([200, []]);
        expect(eventsOf(EXPIRED_REMOVED).map((e) => e.event)).toEqual(['mint', 'offer_create', 'offer_removed']);
      });

      it('pages with the marker (created_ledger, tx_index, event_index): pages of 1, 2 and 5 concatenate to the whole', async () => {
        for (const id of [FULL, BUSY]) {
          const want = openOffersOf(eventsOf(id)).map(offerOf);
          for (const limit of [1, 2, 5]) {
            const walked = await api.pages<{ offers: Obj[]; marker?: string }>(
              `/v2/nfts/${id}/offers`,
              limit,
              'offers',
            );
            expect([id, limit, walked.flatMap((p) => p.offers)]).toEqual([id, limit, want]);
            walked.forEach((p, i) => {
              if (i < walked.length - 1) expect(p.offers).toHaveLength(limit);
              else expect(p.marker).toBeUndefined();
            });
          }
        }
        const page = await get(`/v2/nfts/${BUSY}/offers?limit=2`);
        const second = openOffersOf(eventsOf(BUSY))[1];
        expect(decodeMarker(page.body.marker)).toEqual([second.ledger_index, second.tx_index, second.event_index]);
        expect(Object.keys(page.body)).toEqual(['result', 'coverage', 'count', 'marker', 'offers']);
        // by side, the pages are those of the side
        const sells = openOffersOf(eventsOf(BUSY))
          .filter((e) => e.is_sell_offer === 1)
          .map(offerOf);
        const walked = await api.pages<{ offers: Obj[]; marker?: string }>(
          `/v2/nfts/${BUSY}/offers?type=sell`,
          2,
          'offers',
        );
        expect(walked.flatMap((p) => p.offers)).toEqual(sells);
      });

      it('an offer that was made before the marker and ended after it is not listed on the next page', async () => {
        // FULL: BOB's offer for 20 is older than the offer for 30 that heads the list, and the sale that takes it comes after that one
        const first = await get(`/v2/nfts/${FULL}/offers?limit=1`);
        expect((first.body.offers as Obj[]).map((o) => o.amount)).toEqual(['30']);
        const next = await get(`/v2/nfts/${FULL}/offers?limit=1&marker=${first.body.marker}`);
        expect((next.body.offers as Obj[]).map((o) => o.amount)).toEqual(['15']);
        expect(next.body.marker).toBeUndefined();
        const sells = await get(`/v2/nfts/${FULL}/offers?type=sell&limit=1`);
        expect((sells.body.offers as Obj[]).map((o) => o.amount)).toEqual(['30']);
        expect(sells.body.marker).toBeUndefined();
      });

      it('sets the Link header on a page with a next one and none on the last page', async () => {
        const page = await get(`/v2/nfts/${BUSY}/offers?limit=2&type=sell`);
        const origin = new URL(page.request.url).origin;
        expect(page.headers.link).toBe(
          `<${origin}/v2/nfts/${BUSY}/offers?limit=2&type=sell&marker=${page.body.marker}>; rel="next"`,
        );
        expect((await get(`/v2/nfts/${FULL}/offers`)).headers.link).toBeUndefined();
      });

      it('limits like the other lists: 200 by default, a decimal is cut, below one is the default', async () => {
        const want = openOffersOf(eventsOf(BUSY)).map(offerOf);
        for (const [limit, count] of [
          ['', want.length],
          ['0', want.length],
          ['abc', want.length],
          ['2.9', 2],
          ['5000', want.length],
        ] as const) {
          const res = await get(`/v2/nfts/${BUSY}/offers?limit=${limit}`);
          expect([limit, res.status, res.body.count]).toEqual([limit, 200, count]);
        }
      });
    } else {
      it("an NFT has at most one open offer, the entry's, whatever it has been through", async () => {
        for (const id of byNft.keys()) {
          const offers = (await get(`/v2/nfts/${id}/offers`)).body.offers as Obj[];
          expect([id, offers.length <= 1]).toEqual([id, true]);
          for (const offer of offers) expect([id, offer.offer_id]).toEqual([id, id]);
        }
        // FULL made it, had it cancelled, and made it again; BUSY made it a dozen times: one each
        expect(eventsOf(FULL).filter((e) => e.event.startsWith('offer_')).length).toBeGreaterThan(3);
        expect(((await get(`/v2/nfts/${FULL}/offers`)).body.offers as Obj[]).length).toBe(1);
        expect(((await get(`/v2/nfts/${BUSY}/offers`)).body.offers as Obj[]).length).toBe(1);
      });
    }

    it('ignores the params it does not know, and has no CSV form: format=csv is the JSON answer', async () => {
      const want = openOffersOf(eventsOf(FULL)).map(offerOf);
      expect((await get(`/v2/nfts/${FULL}/offers?nothing=1&event=sale&start=x&descending=true`)).body.offers).toEqual(
        want,
      );
      const csv = await get(`/v2/nfts/${FULL}/offers?format=csv`);
      expect(csv.headers['content-type']).toMatch(/application\/json/);
      expect(csv.body.offers).toEqual(want);
    });
  });

  // -- the contract -------------------------------------------------------------------------------------------------------

  describe('the contract of the routes', () => {
    it('answers the errors in the order id, start, end, event, type, marker, then the 404', async () => {
      const bad = '!!!';
      const answer = async (path: string): Promise<[number, string]> => {
        const res = await get(path);
        return [res.status, res.body.message];
      };
      // the history: the id first, then start, end, event and the marker; an id that is none is a 400 whatever follows it
      expect(await answer(`/v2/nfts/${'F'.repeat(63)}/history?start=x&end=x&event=x&marker=${bad}`)).toEqual([
        400,
        'invalid nft id',
      ]);
      expect(await answer(`/v2/nfts/${FULL}/history?start=x&end=x&event=x&marker=${bad}`)).toEqual([
        400,
        'invalid start date format',
      ]);
      expect(await answer(`/v2/nfts/${FULL}/history?end=x&event=x&marker=${bad}`)).toEqual([
        400,
        'invalid end date format',
      ]);
      expect(await answer(`/v2/nfts/${FULL}/history?event=x&marker=${bad}`)).toEqual([400, 'invalid event']);
      expect(await answer(`/v2/nfts/${FULL}/history?marker=${bad}`)).toEqual([400, 'invalid marker']);
      // the offers: the id, the type, the marker
      expect(await answer(`/v2/nfts/${'G'.repeat(64)}/offers?type=x&marker=${bad}`)).toEqual([400, 'invalid nft id']);
      expect(await answer(`/v2/nfts/${FULL}/offers?type=x&marker=${bad}`)).toEqual([400, 'invalid type']);
      expect(await answer(`/v2/nfts/${FULL}/offers?marker=${bad}`)).toEqual([400, 'invalid marker']);
      // the detail: the id
      expect(await answer(`/v2/nfts/${'f'.repeat(65)}`)).toEqual([400, 'invalid nft id']);
      // the marker is the client's mistake whatever the NFT is: a 400 before the 404
      expect(await answer(`/v2/nfts/${synthId(0xbeef)}/history?marker=${bad}`)).toEqual([400, 'invalid marker']);
      expect(await answer(`/v2/nfts/${synthId(0xbeef)}/offers?marker=${bad}`)).toEqual([400, 'invalid marker']);
      expect(await answer(`/v2/nfts/${synthId(0xbeef)}/history`)).toEqual([404, 'nft not found']);
    });

    it('answers 400 invalid marker for a marker that is none of its own', async () => {
      const key = (values: unknown[]): string => Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
      for (const marker of [
        'not base64 !',
        key([]),
        key([1, 2]),
        key([1, 2, 3, 4]),
        key(['a', 1, 2]),
        key([-1, 0, 0]),
        key([1, 2, 70_000]),
        key([null, 1, 2]),
        Buffer.from('{"a":1}').toString('base64url'),
      ]) {
        for (const route of ['history', 'offers']) {
          const res = await get(`/v2/nfts/${FULL}/${route}?marker=${encodeURIComponent(marker)}`);
          expect([route, marker, res.status, res.body]).toEqual([
            route,
            marker,
            400,
            { result: 'error', message: 'invalid marker' },
          ]);
        }
      }
    });

    it('answers Cache-Control private, max-age=60 on its answers, no-store on its errors, and 401 without a key', async () => {
      for (const path of [`/v2/nfts/${FULL}`, `/v2/nfts/${FULL}/history`, `/v2/nfts/${FULL}/offers`]) {
        const ok = await get(path);
        expect([path, ok.status, ok.headers['cache-control']]).toEqual([path, 200, 'private, max-age=60']);
        const missing = await get(path.replace(FULL, synthId(0xcafe)));
        expect([path, missing.status, missing.headers['cache-control']]).toEqual([path, 404, 'no-store']);
        const unauthorized = await h.http().get(path);
        expect([path, unauthorized.status]).toEqual([path, 401]);
      }
    });

    describe('when the database fails', () => {
      const cases: [string, string, string][] = [
        ['the detail', `/v2/nfts/${FULL}`, 'unable to retrieve nft'],
        ['the history', `/v2/nfts/${FULL}/history`, 'unable to retrieve nft history'],
        ['the offers', `/v2/nfts/${FULL}/offers`, 'unable to retrieve offers'],
      ];

      it.each(cases)('%s is a 500 with its own message', async (_name, path, message) => {
        jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
        const res = await get(path);
        expect([res.status, res.body]).toEqual([500, { result: 'error', message }]);
      });

      it('a failed read of the coverage fails the route, and nothing is kept: the next request is whole again', async () => {
        const real = h.ch.query.bind(h.ch);
        jest
          .spyOn(h.ch, 'query')
          .mockImplementation(((sql: string, ...rest: unknown[]) =>
            sql.includes(`FROM ${Table.Ledgers} WHERE parser_version`)
              ? Promise.reject(new Error('boom'))
              : (real as (...a: unknown[]) => unknown)(sql, ...rest)) as never);
        await api.ok('/v2/test-cache/clear', 'result');
        const failed = await get(`/v2/nfts/${FULL}`);
        expect([failed.status, failed.body]).toEqual([500, { result: 'error', message: 'unable to retrieve nft' }]);
        jest.restoreAllMocks();
        expect((await get(`/v2/nfts/${FULL}`)).status).toBe(200);
      });

      it('a mistake of the client stays a 400 while the database is down', async () => {
        jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
        for (const path of [
          '/v2/nfts/xyz',
          `/v2/nfts/${FULL}/history?start=x`,
          `/v2/nfts/${FULL}/history?event=nope`,
          `/v2/nfts/${FULL}/history?marker=!!!`,
          `/v2/nfts/${FULL}/offers?type=x`,
          `/v2/nfts/${FULL}/offers?marker=!!!`,
        ]) {
          expect([path, (await get(path)).status]).toEqual([path, 400]);
        }
      });
    });
  });

  // -- the price in the native currency: last, since it stores the rate of an asset that the other tests do not know ------------------------------------------------------------------------------------

  describe('the price of a sale in the native currency', () => {
    it('a sale in the native currency has converted_amount, the price itself, in the detail and the history', async () => {
      const id = nftOfCase(world.kind === 'nftoken' ? 'sale_by_sell_offer' : 'uritoken_buy_above_ask');
      const sale = eventsOf(id).find((e) => e.event === 'sale')!;
      const nft = (await get(`/v2/nfts/${id}`)).body.nft as Obj;
      const converted = new BigNumber(sale.amount).toFixed();
      expect((nft.last_sale as Obj).converted_amount).toBe(converted);
      const history = (await get(`/v2/nfts/${id}/history?event=sale`)).body.events as Obj[];
      expect(history).toHaveLength(1);
      expect(history[0].converted_amount).toBe(converted);
      // after the currency (a price in the native currency has no issuer), where the key order has it
      expectOrdered(history[0], EVENT_KEYS);
      const keys = Object.keys(history[0]);
      expect(keys.indexOf('converted_amount')).toBe(keys.indexOf('currency') + 1);
    });

    it('a sale in an issued currency has none until its asset has a rate that day, then the price over the rate, in text', async () => {
      const sale = recorded.find((e) => e.event === 'sale' && e.amount_issuer !== '')!;
      const id = sale.nft_id;
      expect(id).toBeTruthy();
      const before = (await get(`/v2/nfts/${id}`)).body.nft as Obj;
      expect(before.last_sale).not.toHaveProperty('converted_amount');
      expect((before.last_sale as Obj).amount_issuer).toBe(sale.amount_issuer);
      const eventBefore = ((await get(`/v2/nfts/${id}/history?event=sale`)).body.events as Obj[])[0];
      expect(eventBefore).not.toHaveProperty('converted_amount');
      expect(eventBefore.amount_issuer).toBe(sale.amount_issuer);

      // the rate of the asset on the day of the sale: `rate` units of the asset for one native coin
      const rate = world.kind === 'nftoken' ? '4' : '0.5';
      const day = new Date(sale.close_time * 1000).toISOString().slice(0, 10);
      const row = (currency: string, issuer: string, value: string): NativeRatesDailyRow => ({
        currency,
        issuer,
        day,
        rate: value,
        rate_f: Number(value),
        daily_count: 0,
        latest_count: 0,
        config_version: RATES_DAILY_CONFIG_VERSION,
        stale: 0,
        version: 1,
      });
      await h.ch.insert(Table.NativeRatesDaily, [row('', '', '0'), row(sale.currency, sale.amount_issuer, rate)]);
      await api.ok('/v2/test-cache/clear', 'result');

      const expected = new BigNumber(sale.amount).dividedBy(rate).decimalPlaces(6).toFixed();
      const after = (await get(`/v2/nfts/${id}`)).body.nft as Obj;
      expect((after.last_sale as Obj).converted_amount).toBe(expected);
      expectOrdered(after.last_sale as Obj, LAST_SALE_KEYS);
      const eventAfter = ((await get(`/v2/nfts/${id}/history?event=sale`)).body.events as Obj[])[0];
      expect(eventAfter.converted_amount).toBe(expected);
      expectOrdered(eventAfter, EVENT_KEYS);
    });
  });

  it('the aggregates were built over the seed: the nfts, the holdings, the collections and the volume sets', async () => {
    const count = async (table: Table): Promise<number> =>
      Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0].n);
    expect(await count(Table.Nfts)).toBeGreaterThanOrEqual(byNft.size - 1);
    expect(await count(Table.AccountNfts)).toBeGreaterThan(0);
    expect(await count(Table.NftCollections)).toBeGreaterThan(0);
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.VolumeDaily} WHERE metric = 'nft_volume'`,
    );
    expect(Number(n)).toBeGreaterThan(0);
    const [{ live }] = await h.ch.query<{ live: string }>(
      `SELECT count() AS live FROM ${Table.VolumeLive} WHERE metric = 'nft_volume'`,
    );
    expect(Number(live)).toBeGreaterThan(0);
  });
});

// =====================================================================================================================
// Coverage: the start ledger of the feature and the ledgers an older parser wrote

describe.each(WORLDS)('the coverage of the NFT routes on $network', (world) => {
  const E = world.start;
  /** The ledgers stored in a case: an offset from the start ledger, and the parser version that wrote the ledger. */
  interface Case {
    name: string;
    ledgers: [offset: number, version: number][];
    /** The ledger the events are in, the newest stored: the first NFT is minted there, the second sold. */
    at: number;
    /** What the feature answers: where it starts (an offset from the start ledger) and whether it is whole. */
    from: number;
    complete: boolean;
  }
  const ALL_CASES: Case[] = [
    {
      name: 'the start ledger is the first one indexed',
      ledgers: [
        [0, 5],
        [1, 5],
      ],
      at: 1,
      from: 0,
      complete: true,
    },
    {
      name: 'the first indexed ledger is above the start ledger',
      ledgers: [
        [3, 5],
        [4, 5],
      ],
      at: 4,
      from: 3,
      complete: false,
    },
    {
      name: 'a ledger of an older parser at the start ledger moves the coverage to the ledger above it',
      ledgers: [
        [0, 4],
        [1, 5],
        [2, 5],
      ],
      at: 2,
      from: 1,
      complete: false,
    },
    {
      name: 'every ledger stored was written by an older parser: the coverage starts one above the newest of them, a ledger that is not stored',
      ledgers: [
        [0, 4],
        [5, 4],
      ],
      at: 5,
      from: 6,
      complete: false,
    },
    // below the start ledger (not on Xahau, whose first ledger is the start ledger)
    {
      name: 'a ledger of an older parser just below the start ledger leaves the start ledger the first indexed one',
      ledgers: [
        [-1, 4],
        [0, 5],
        [1, 5],
      ],
      at: 1,
      from: 0,
      complete: true,
    },
  ];
  const CASES = ALL_CASES.filter((c) => c.ledgers.every(([offset]) => E + offset >= 1));

  /** Close times grow with the ledger: a ledger is 10 seconds after the one below it. */
  const closeOf = (offset: number): number => 1_700_000_000 + (offset + 10) * 10;
  const identity: Partial<Ev> =
    world.kind === 'nftoken'
      ? { kind: 'nftoken', issuer: ISSUER, taxon: 7, taxon_key: 7, serial: 3, nft_flags: 8, transfer_fee: 0 }
      : { kind: 'uritoken', issuer: ISSUER, taxon: null, taxon_key: 0, serial: 0, nft_flags: 1, transfer_fee: 0 };
  const MINTED = synthId(0xc0de);
  const SOLD = synthId(0xc0df);

  /** Stores the ledgers of a case, and two NFTs in its newest: one minted there, one only sold (its mint is before the index). */
  async function seedCase(h: Harness, c: Case): Promise<void> {
    await h.ch.insert(
      Table.Ledgers,
      c.ledgers.map(([offset, version]) => ({ ...ledgerRow(E + offset, closeOf(offset)), parser_version: version })),
    );
    const base = { ...identity, ledger_index: E + c.at, close_time: closeOf(c.at) };
    await insertNftEvents(h, [
      nftEventRow({ ...base, nft_id: MINTED, account: ALICE, to_account: ALICE }),
      nftEventRow({
        ...base,
        nft_id: SOLD,
        tx_index: 2000,
        tx_type: 'NFTokenAcceptOffer',
        event: 'sale',
        account: BOB,
        from_account: ALICE,
        to_account: BOB,
        amount: '1',
        amount_f: 1,
        currency: world.native,
      }),
    ]);
  }

  /** A harness with the amendment enabled in the newest `network_state`, as the network reports it. */
  async function startCase(): Promise<{ h: Harness; api: ApiClient }> {
    const h = await startHarness({
      seed: 'none',
      network: world.network,
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    return { h, api: await h.api() };
  }

  async function enableAmendment(h: Harness, api: ApiClient, ledger: number): Promise<void> {
    await insertState(h.ch, [
      { ledger_index: ledger, polled_at: Date.now() / 1000, amendments: [amendmentId(world.amendment)] },
    ]);
    // the coverage is kept for 60 s, the amendments and the directory they are built on for 10 s
    await api.ok('/v2/test-cache/clear', 'result');
  }

  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { h, api } = await startCase();
    try {
      await seedCase(h, c);
      await enableAmendment(h, api, E + c.at);
      const from = E + c.from;
      for (const route of ['', '/history', '/offers']) {
        // minted in the index: whole when the mint is at or above where the coverage starts, whatever the feature's is
        const minted = await api.get(`/v2/nfts/${MINTED}${route}`);
        expect([route, minted.status]).toEqual([route, 200]);
        expect([route, minted.body.coverage]).toEqual([
          route,
          { from_ledger_index: from, complete: c.complete || E + c.at >= from },
        ]);
        // sold with no mint in the index: only the feature's coverage can say
        const sold = await api.get(`/v2/nfts/${SOLD}${route}`);
        expect([route, sold.status]).toEqual([route, 200]);
        expect([route, sold.body.coverage]).toEqual([route, { from_ledger_index: from, complete: c.complete }]);
        expect(Object.keys(sold.body.coverage)).toEqual(['from_ledger_index', 'complete']);
      }
    } finally {
      await h.close();
    }
  });

  it('is incomplete while the amendment is not enabled in the newest network_state, whatever the first ledger, and complete once it is', async () => {
    const { h, api } = await startCase();
    try {
      await seedCase(h, CASES[0]);
      await api.ok('/v2/test-cache/clear', 'result');
      // the enable ledger is not known: the file's date is for a network that has the amendment
      expect((await api.get(`/v2/nfts/${SOLD}`)).body.coverage).toEqual({ from_ledger_index: E, complete: false });
      await enableAmendment(h, api, E + 1);
      expect((await api.get(`/v2/nfts/${SOLD}`)).body.coverage).toEqual({ from_ledger_index: E, complete: true });
    } finally {
      await h.close();
    }
  });

  it('answers 404 nft not found on an empty database, and 400 for a mistake of the client', async () => {
    const { h, api } = await startCase();
    try {
      for (const route of ['', '/history', '/offers']) {
        const res = await api.get(`/v2/nfts/${synthId(1)}${route}`);
        expect([route, res.status, res.body]).toEqual([route, 404, { result: 'error', message: 'nft not found' }]);
      }
      expect((await api.get('/v2/nfts/nope')).status).toBe(400);
    } finally {
      await h.close();
    }
  });
});
