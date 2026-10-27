import { NFT_ROLES, Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, decodeMarker, iso } from './support/amm';
import { fixtureSource } from './support/fixtures';
import {
  accountsOf,
  historyOf as historyOracle,
  holdingsOf as holdingsOracle,
  rolesOfEvent,
} from './support/nft-accounts-oracle';
import {
  idOfKey,
  Key,
  owner,
  priceOf,
  priceText,
  rateRows,
  ratesOf,
  syntheticCollections,
} from './support/nft-collections-oracle';
import { expectListContract, expectWalk } from './support/nft-lists';
import { buildNftAggregates, fixtureNftEvents, insertNftEvents, nftEventRow } from './support/nfts';
import {
  ALICE,
  compareKeys,
  Ev,
  eventOf,
  expectOrdered,
  Obj,
  Slot,
  syntheticEvents,
  synthId,
  WORLDS,
} from './support/nfts-oracle';
import { innerRead, isPageRead } from './support/plans';

/**
 * `GET /v2/accounts/{address}/nfts` and `/nft_history` on a real ClickHouse, for each network: the recorded ledgers of the NFT
 * fixtures with the aggregates built over them, the NFTs of the NFT suite and the collections of the collection suite made by hand
 * (their transactions say `synthetic-…`), and a few NFTs of this suite for what none of them has: an issuer that sells its own NFT
 * (two roles in one event), a minter that is not the issuer. The aggregates are built twice, the second time over events that
 * change the first rows (a holder gives up what it held, an NFT is sold on, another is burned), so that `account_nfts` has older
 * and newer versions of its rows and the route has to read the newest.
 *
 * What the routes answer is checked against an oracle in plain JavaScript over the events (`support/nft-accounts-oracle.ts` and
 * the oracles of the other NFT suites): the NFTs an account holds and the events it is named in, none of it from the code under
 * test.
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
const NFT_CSV_COLUMNS = [
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

/** A marker that is none of ours: not even base64url. */
const BAD_MARKER = '!!!';
/** The marker of a key, written by hand: its values as JSON, in base64url. */
const base64 = (values: unknown[]): string => Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
/** An X-address (of an account and a tag): the routes under an account do not check the address, so it is one that holds nothing. */
const X_ADDRESS = 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ';

describe.each(WORLDS)('the NFT routes of an account over the recorded $seed ledgers', (world) => {
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
  const [c0, c1, c2, c3, c4, c5, c6, c7] = hand.keys;

  // -- the NFTs of this suite: an issuer that sells its own NFT (two roles in one event) and a minter that is not the issuer
  const SELLER = accountAt(0x31);
  const BUYER = accountAt(0x32);
  const MINTER = accountAt(0x33);
  const EXTRA_ISSUER = accountAt(0x34);
  const SOLD = synthId(0x200001);
  const MINTED = synthId(0x200002);
  const [early, middle] = [slots[0], slots[Math.floor(slots.length / 2)]];
  const extra: Ev[] = (() => {
    const nft = (id: string, serial: number): Partial<Ev> => ({
      nft_id: id,
      kind: xrpl ? 'nftoken' : 'uritoken',
      issuer: EXTRA_ISSUER,
      taxon: xrpl ? 9 : null,
      taxon_key: xrpl ? 9 : 0,
      serial: xrpl ? serial : 0,
      nft_flags: xrpl ? 8 : 1,
      transfer_fee: xrpl ? 100 : 0,
    });
    const at = (slot: Slot, tx: number, over: Partial<Ev>): Ev =>
      nftEventRow({
        ledger_index: slot.index,
        close_time: slot.close,
        tx_index: tx,
        event_index: 0,
        uri: '',
        account: '',
        from_account: '',
        to_account: '',
        ...over,
      });
    return [
      // the issuer mints to itself (roles issuer and to), then sells the NFT to BUYER (roles issuer and from)
      at(early, 9001, {
        ...nft(SOLD, 1),
        tx_type: xrpl ? 'NFTokenMint' : 'URITokenMint',
        event: 'mint',
        account: EXTRA_ISSUER,
        to_account: EXTRA_ISSUER,
      }),
      at(middle, 9002, {
        ...nft(SOLD, 1),
        tx_type: xrpl ? 'NFTokenAcceptOffer' : 'URITokenBuy',
        event: 'sale',
        account: BUYER,
        from_account: EXTRA_ISSUER,
        to_account: BUYER,
        offer_id: synthId(0x200010),
        is_sell_offer: 1,
        amount: '12',
        amount_f: 12,
        currency: world.native,
      }),
      // a minter that is not the issuer mints to itself (roles minter and to)
      at(early, 9003, {
        ...nft(MINTED, 2),
        tx_type: xrpl ? 'NFTokenMint' : 'URITokenMint',
        event: 'mint',
        account: MINTER,
        to_account: MINTER,
      }),
      // SELLER lists its NFT for BUYER alone (roles offer_owner and destination)
      at(middle, 9004, {
        ...nft(MINTED, 2),
        tx_type: xrpl ? 'NFTokenCreateOffer' : 'URITokenCreateSellOffer',
        event: 'offer_create',
        account: SELLER,
        offer_id: synthId(0x200011),
        is_sell_offer: 1,
        amount: '5',
        amount_f: 5,
        currency: world.native,
        destination: BUYER,
      }),
    ];
  })();

  /** The events of every NFT in the order of the index, up to the head: what the routes can see. */
  const committed = [...recorded, ...made.rows, ...extra, ...hand.first, ...hand.second].sort(compareKeys);
  const byNft = new Map<string, Ev[]>();
  for (const e of committed) {
    const list = byNft.get(e.nft_id);
    if (list) list.push(e);
    else byNft.set(e.nft_id, [e]);
  }
  const ACCOUNTS = accountsOf(committed);
  const [P1, P2, P3, P4, P5] = [owner(1), owner(2), owner(3), owner(4), owner(5)];
  const BROKER = accountAt(0x77);
  const price = (e: Ev): string | undefined => priceText(priceOf(e, rates));
  const holdings = (account: string, collection?: { issuer?: string; taxon_key?: number }): Obj[] =>
    holdingsOracle(byNft, account, collection);
  const history = (account: string, filter?: { events?: string[]; roles?: string[] }): Obj[] =>
    historyOracle(committed, account, filter).map((e) => eventOf(e, price));
  const nftsPath = (account: string): string => `/v2/accounts/${account}/nfts`;
  const historyPath = (account: string): string => `/v2/accounts/${account}/nft_history`;

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: world.seed, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    // the rates the sales are priced with, there before the aggregates are built
    await h.ch.insert(Table.NativeRatesDaily, rateRows(hand.rates));
    await insertNftEvents(h, made.rows);
    // events above the committed head: the ledger is not committed, so none of the routes may serve them
    await insertNftEvents(h, made.above);
    await insertNftEvents(h, extra);
    await insertNftEvents(h, hand.first);
    // the events of one account are in `account_nft_events` twice, as a re-ingest can leave them
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AccountNftEvents}`);
    await h.ch.command(
      `INSERT INTO ${Table.AccountNftEvents} SELECT * FROM ${Table.AccountNftEvents} WHERE account = {account:String}`,
      { account: P3 },
      { settings: { insert_deduplicate: 0 } },
    );
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
    expect(committed.length).toBeGreaterThan(80);
    // an event has one place in its transaction: the key of the history is unique among the events of an account
    for (const account of [P1, P3, BROKER, EXTRA_ISSUER, ALICE]) {
      const keys = historyOracle(committed, account).map((e) => `${e.ledger_index}:${e.tx_index}:${e.event_index}`);
      expect([account, new Set(keys).size]).toEqual([account, keys.length]);
    }
    expect(ACCOUNTS.length).toBeGreaterThan(30);
    // account_nfts has older and newer versions of the holdings the second build changed: P2 held c5's NFT, then sold it
    const soldAway = [...byNft.values()].find(
      (list) => list[0].issuer === c5.issuer && list[list.length - 1].event === 'sale',
    );
    const id = (soldAway as Ev[])[0].nft_id;
    const rows = await h.ch.query<{ held: string }>(
      `SELECT held FROM ${Table.AccountNfts} WHERE owner = {owner:String} AND nft_id = {id:String} ORDER BY version`,
      { owner: P2, id },
    );
    expect(rows.map((r) => Number(r.held))).toEqual([1, 0]);
    // the account that two events name twice has two rows of the same key in account_nft_events (not yet merged)
    const [twice] = await h.ch.query<{ n: string; distinct: string }>(
      `SELECT count() AS n, uniqExact(ledger_index, tx_index, event_index) AS distinct FROM ${Table.AccountNftEvents} WHERE account = {account:String}`,
      { account: P3 },
    );
    expect(Number(twice.n)).toBe(2 * Number(twice.distinct));
    // an account with two roles in an event has one row of it, with both roles
    const [two] = await h.ch.query<{ n: string; roles: string[] }>(
      `SELECT count() AS n, any(roles) AS roles FROM ${Table.AccountNftEvents}
        WHERE account = {account:String} AND nft_id = {id:String} AND event = 'mint'`,
      { account: EXTRA_ISSUER, id: SOLD },
    );
    expect([Number(two.n), two.roles]).toEqual([1, ['issuer', 'to']]);
  });

  // -- the NFTs an account holds ------------------------------------------------------------------------------------------

  describe('GET /v2/accounts/{address}/nfts', () => {
    // (every account of the data, as the oracle holds its NFTs)
    it('lists the holdings by collection then serial and drops an NFT sold away', async () => {
      let holders = 0;
      for (const account of ACCOUNTS) {
        const want = holdings(account);
        const res = await get(`${nftsPath(account)}?limit=1000`);
        expect([account, res.status]).toEqual([account, 200]);
        expect([account, res.body.nfts]).toEqual([account, want]);
        expect([account, res.body.count]).toEqual([account, want.length]);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'nfts']);
        expect(res.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
        for (const nft of res.body.nfts as Obj[]) expectOrdered(nft, NFT_KEYS, nft.nft_id);
        if (want.length > 0) holders += 1;
      }
      expect(holders).toBeGreaterThan(10);
    });

    it('lists them by collection (issuer, then taxon) and then serial, whatever the order of the ids', async () => {
      // P1 holds NFTs in five collections (XRPL: of four issuers), and on Xahau in as many issuers
      const mine = (await get(`${nftsPath(P1)}?limit=1000`)).body.nfts as Obj[];
      type Position = [string, number, number, string];
      const position = (n: Obj): Position => [
        n.issuer as string,
        (n.taxon as number | undefined) ?? 0,
        (n.serial as number | undefined) ?? 0,
        n.nft_id as string,
      ];
      const before = (a: Position, b: Position): number =>
        (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) ||
        a[1] - b[1] ||
        a[2] - b[2] ||
        (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0);
      const positions = mine.map(position);
      expect(positions).toEqual([...positions].sort(before));
      const collections = new Set(positions.map(([issuer, taxon]) => `${issuer}/${taxon}`));
      expect(collections.size).toBeGreaterThanOrEqual(5);
      expect(new Set(positions.map(([issuer]) => issuer)).size).toBeGreaterThanOrEqual(xrpl ? 4 : 5);
      // c2: five NFTs whose serials are scrambled against their ids, two of them P1's: by serial, not by id
      const c2nfts = mine.filter((n) => n.issuer === c2.issuer && (!xrpl || n.taxon === c2.taxon_key));
      expect(c2nfts).toHaveLength(2);
      if (xrpl) {
        const serials = c2nfts.map((n) => n.serial as number);
        expect(serials).toEqual([...serials].sort((a, b) => a - b));
      }
    });

    it('drops an NFT sold away, given away or burned though an older version of its row says it is held', async () => {
      // c5: P2 held an NFT, the second build sold it to P1; c0: P1 gave one up to P2; c4: P1 minted three, sold one and had one burned
      const heldBy = async (account: string, key: Key): Promise<Obj[]> =>
        ((await get(`${nftsPath(account)}?limit=1000`)).body.nfts as Obj[]).filter(
          (n) => n.issuer === key.issuer && (!xrpl || n.taxon === key.taxon_key),
        );
      expect(await heldBy(P2, c5)).toEqual([]);
      expect((await heldBy(P1, c5)).length).toBe(2);
      expect((await heldBy(P1, c0)).length).toBe(0);
      expect((await heldBy(P2, c0)).length).toBe(3);
      expect((await heldBy(P1, c4)).length).toBe(1);
      // the rows say so: the older row of P2 holds, the newer does not (the route reads the newest of each key)
      const rows = await h.ch.query<{ n: string; held_now: string }>(
        `SELECT count() AS n, sum(held) AS held_now FROM ${Table.AccountNfts} WHERE owner = {owner:String}
          AND issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32}`,
        { owner: P2, issuer: c5.issuer, taxon_key: c5.taxon_key },
      );
      expect(Number(rows[0].n)).toBeGreaterThan(Number(rows[0].held_now));
      // an NFT of the burned collection is nobody's
      for (const account of [P1, P2, P3, P4, P5]) expect(await heldBy(account, c7)).toEqual([]);
      // the NFTs of the issuer that sold its own: the buyer has it, the seller does not
      expect(((await get(nftsPath(BUYER))).body.nfts as Obj[]).map((n) => n.nft_id)).toEqual([SOLD]);
      expect((await get(nftsPath(EXTRA_ISSUER))).body.nfts).toEqual([]);
      expect(((await get(nftsPath(MINTER))).body.nfts as Obj[]).map((n) => n.nft_id)).toEqual([MINTED]);
    });

    it('issuer keeps the NFTs of that issuer, issuer and taxon those of the collection', async () => {
      // P1 holds NFTs of c4 and c1 (XRPL: the same issuer for c3 and c4, and for c0, c1, c2)
      const sameIssuer = ((await get(`${nftsPath(P1)}?limit=1000&issuer=${c1.issuer}`)).body.nfts as Obj[]).length;
      expect(sameIssuer).toBe(holdings(P1, { issuer: c1.issuer }).length);
      expect(sameIssuer).toBeGreaterThanOrEqual(xrpl ? 3 : 1);
      for (const key of [c1, c2, c4, c5, c6, c0]) {
        const byIssuer = await get(`${nftsPath(P1)}?limit=1000&issuer=${key.issuer}`);
        expect([idOfKey(key), byIssuer.body.nfts]).toEqual([idOfKey(key), holdings(P1, { issuer: key.issuer })]);
        const byCollection = await get(`${nftsPath(P1)}?limit=1000&issuer=${key.issuer}&taxon=${key.taxon_key}`);
        expect([idOfKey(key), byCollection.status]).toEqual([idOfKey(key), 200]);
        expect([idOfKey(key), byCollection.body.nfts]).toEqual([idOfKey(key), holdings(P1, key)]);
        expect(byCollection.body.count).toBe(holdings(P1, key).length);
      }
      // the same with the walk, and with the marker inside the collection
      await expectWalk(api, `${nftsPath(P1)}?issuer=${c2.issuer}&taxon=${c2.taxon_key}`, 'nfts', holdings(P1, c2), [1]);
      // an issuer P1 holds nothing of, a taxon of the issuer that P1 holds nothing of, a taxon the issuer has none of
      expect((await get(`${nftsPath(P1)}?issuer=${accountAt(0x9999)}`)).body).toMatchObject({ count: 0, nfts: [] });
      expect((await get(`${nftsPath(P1)}?issuer=${c1.issuer}&taxon=77`)).body).toMatchObject({ count: 0, nfts: [] });
      expect((await get(`${nftsPath(P1)}?issuer=${c7.issuer}&taxon=${c7.taxon_key}`)).body).toMatchObject({ count: 0 });
      // an empty issuer or taxon is none
      expect((await get(`${nftsPath(P1)}?issuer=&taxon=&limit=1000`)).body.nfts).toEqual(holdings(P1));
    });

    it('answers 400 invalid taxon for a taxon alone, and for a taxon that is none; invalid issuer address first', async () => {
      const answer = async (query: string): Promise<[number, string]> => {
        const res = await get(`${nftsPath(P1)}?${query}`);
        return [res.status, res.body.message];
      };
      expect(await answer('taxon=1')).toEqual([400, 'invalid taxon']);
      expect(await answer('taxon=0')).toEqual([400, 'invalid taxon']);
      expect(await answer(`issuer=&taxon=1`)).toEqual([400, 'invalid taxon']);
      for (const taxon of ['x', '-1', '1.5', '4294967296', '0x1']) {
        expect([taxon, await answer(`issuer=${c1.issuer}&taxon=${taxon}`)]).toEqual([taxon, [400, 'invalid taxon']]);
      }
      expect(await answer('issuer=xyz')).toEqual([400, 'invalid issuer address']);
      expect(await answer('issuer=xyz&taxon=x')).toEqual([400, 'invalid issuer address']);
      expect(await answer(`issuer=xyz&taxon=1&marker=${BAD_MARKER}`)).toEqual([400, 'invalid issuer address']);
      expect(await answer(`taxon=x&marker=${BAD_MARKER}`)).toEqual([400, 'invalid taxon']);
      expect(await answer(`issuer=${c1.issuer}&marker=${BAD_MARKER}`)).toEqual([400, 'invalid marker']);
      expect(await answer(`marker=${BAD_MARKER}`)).toEqual([400, 'invalid marker']);
      // a mistake of the client is answered before any read
      const spy = jest.spyOn(h.ch, 'query');
      await answer('taxon=1');
      await answer(`marker=${BAD_MARKER}`);
      expect(spy).not.toHaveBeenCalled();
    });

    it('an X-address and an address that holds nothing have an empty list: the address is not checked', async () => {
      for (const account of [X_ADDRESS, owner(99), accountAt(0x9998), 'xyz', 'not an address', EXTRA_ISSUER]) {
        const res = await get(nftsPath(encodeURIComponent(account)));
        expect([account, res.status, res.body.count, res.body.nfts]).toEqual([account, 200, 0, []]);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'nfts']);
        expect(res.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
        expect(res.body).not.toHaveProperty('marker');
      }
    });

    it('pages with the marker (issuer, taxon_key, serial, nft_id), across collections', async () => {
      const mine = holdings(P1);
      expect(mine.length).toBeGreaterThanOrEqual(6);
      await expectWalk(api, nftsPath(P1), 'nfts', mine, [1, 2, 3, 7]);
      await expectWalk(api, nftsPath(P4), 'nfts', holdings(P4), [1]);
      await expectWalk(api, `${nftsPath(P1)}?issuer=${c4.issuer}`, 'nfts', holdings(P1, { issuer: c4.issuer }), [1, 2]);
      // the marker is the issuer, the taxon, the serial and the id of the last NFT of the page: on Xahau a taxon and a serial are 0
      const page = await get(`${nftsPath(P1)}?limit=2`);
      const last = (page.body.nfts as Obj[])[1];
      expect(decodeMarker(page.body.marker)).toEqual([
        last.issuer,
        (last.taxon as number | undefined) ?? 0,
        (last.serial as number | undefined) ?? 0,
        last.nft_id,
      ]);
      expect(Object.keys(page.body)).toEqual(['result', 'coverage', 'count', 'marker', 'nfts']);
      // a marker inside a collection, written by hand, goes on from there; a marker on another account's key too
      const first = mine[0];
      const second = await get(
        `${nftsPath(P1)}?limit=1&marker=${base64([first.issuer, (first.taxon as number | undefined) ?? 0, (first.serial as number | undefined) ?? 0, first.nft_id])}`,
      );
      expect(second.body.nfts).toEqual([mine[1]]);
      const beyond = await get(
        `${nftsPath(P1)}?marker=${base64(['rzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 0, 0, 'F'.repeat(64)])}`,
      );
      expect(beyond.body).toMatchObject({ count: 0, nfts: [] });
    });

    it('last_sale has no converted_amount in a list, and has it in the detail of the same NFT', async () => {
      const id = synthId(0x100000 + 3 * 100);
      // c3's NFT was sold three times, and P4 holds it
      const listed = ((await get(nftsPath(P4))).body.nfts as Obj[]).find((n) => n.nft_id === id) as Obj;
      expect(listed.sale_count).toBe(3);
      expect(listed.last_sale).toMatchObject({ amount: '3', currency: world.native });
      expect(listed.last_sale).not.toHaveProperty('converted_amount');
      const detail = (await get(`/v2/nfts/${id}`)).body.nft as Obj;
      expect((detail.last_sale as Obj).converted_amount).toBe('3');
      expect({ ...detail, last_sale: undefined }).toEqual({ ...listed, last_sale: undefined });
    });

    it('reads the newest nfts row of each NFT of the page by its whole key, in one read', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await api.ok(`${nftsPath(P1)}?limit=1000`, 'nfts');
      const reads = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.Nfts}`));
      expect(reads).toHaveLength(1);
      const sql = String(reads[0][0]);
      expect(sql).toContain('(issuer, taxon_key, serial, nft_id) IN');
      expect(sql).toContain('LIMIT 1 BY issuer, taxon_key, serial, nft_id');
      expect(sql).not.toMatch(/\bFINAL\b/i);
      // the holdings: the newest row of each key, kept when held, in the order of the key and not past the cap
      const page = spy.mock.calls.filter(([text]) => String(text).includes('{newest_page_cap:UInt32}'));
      expect(page).toHaveLength(1);
      expect(String(page[0][0])).toContain('held = 1');
      // an account that holds nothing reads no nfts at all
      spy.mockClear();
      await api.ok(nftsPath(owner(99)), 'nfts');
      expect(spy.mock.calls.filter(([text]) => String(text).includes(`FROM ${Table.Nfts}`))).toHaveLength(0);
    });
  });

  // -- the history ----------------------------------------------------------------------------------------------------------

  describe('GET /v2/accounts/{address}/nft_history', () => {
    it('lists the events an account is named in, oldest first: every account of the data, as the oracle has them', async () => {
      let total = 0;
      for (const account of ACCOUNTS) {
        const want = history(account);
        const res = await get(`${historyPath(account)}?limit=1000`);
        expect([account, res.status]).toEqual([account, 200]);
        expect([account, res.body.events]).toEqual([account, want]);
        expect(res.body.count).toBe(want.length);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'events']);
        for (const event of res.body.events as Obj[]) expectOrdered(event, EVENT_KEYS, event.tx_hash);
        total += want.length;
      }
      // an event is listed for each account it names: more rows than events
      expect(total).toBeGreaterThan(committed.length);
      const down = await get(`${historyPath(P1)}?limit=1000&descending=true`);
      expect(down.body.events).toEqual(history(P1).reverse());
    });

    it('the event is the actor in the place of account: who did it, not the account the history is of', async () => {
      // BROKER is named by its brokered sale, which the buyer did
      const sale = (await get(historyPath(BROKER))).body.events as Obj[];
      expect(sale).toHaveLength(1);
      expect(sale[0]).toMatchObject({ event: 'sale', broker: BROKER });
      const e = committed.find((x) => x.broker === BROKER) as Ev;
      expect(sale[0].account).toBe(e.account);
      expect(sale[0].account).not.toBe(BROKER);
      expect(sale[0]).not.toHaveProperty('actor');
      expect(sale[0]).not.toHaveProperty('mode');
      expect(sale[0]).not.toHaveProperty('roles');
      // converted_amount on sales only
      expect(sale[0].converted_amount).toBe('3');
      const mints = ((await get(`${historyPath(P1)}?limit=1000&event=mint`)).body.events as Obj[]).filter(
        (x) => x.event === 'mint',
      );
      expect(mints.length).toBeGreaterThan(0);
      for (const mint of mints) expect(mint).not.toHaveProperty('converted_amount');
    });

    it('role=broker is the brokered sales, role=issuer,to the events the account issued or received, role=nope is a 400', async () => {
      const wantRole = async (account: string, role: string): Promise<void> => {
        const roles = role.split(',');
        const res = await get(`${historyPath(account)}?limit=1000&role=${role}`);
        expect([account, role, res.status]).toEqual([account, role, 200]);
        expect([account, role, res.body.events]).toEqual([account, role, history(account, { roles })]);
      };
      await wantRole(BROKER, 'broker');
      expect((await get(`${historyPath(BROKER)}?role=broker`)).body.count).toBe(1);
      // an account that is not a broker has no event with that role
      expect((await get(`${historyPath(P1)}?role=broker`)).body).toMatchObject({ count: 0, events: [] });
      // the issuer: of the mints, burns and sales of its NFTs, and the events it is on the other side of
      const issuer = c4.issuer;
      await wantRole(issuer, 'issuer');
      await wantRole(issuer, 'to');
      await wantRole(issuer, 'issuer,to');
      await wantRole(issuer, 'to,issuer');
      const issued = history(issuer, { roles: ['issuer'] }).length;
      const received = history(issuer, { roles: ['to'] }).length;
      const either = history(issuer, { roles: ['issuer', 'to'] }).length;
      expect(issued).toBeGreaterThan(0);
      expect(either).toBeLessThanOrEqual(issued + received);
      expect(either).toBeGreaterThanOrEqual(Math.max(issued, received));
      // every role, for the account that has them
      for (const role of NFT_ROLES) {
        for (const account of [SELLER, BUYER, MINTER, EXTRA_ISSUER, BROKER, P1]) await wantRole(account, role);
      }
      // a mistake in the list is a 400, a member that is none, an empty one, a repeat is fine
      for (const role of ['nope', 'issuer,nope', 'issuer,', ',issuer', 'ISSUER', 'issuer to']) {
        const res = await get(`${historyPath(P1)}?role=${encodeURIComponent(role)}`);
        expect([role, res.status, res.body]).toEqual([role, 400, { result: 'error', message: 'invalid role' }]);
      }
      expect((await get(`${historyPath(P1)}?limit=1000&role=issuer,issuer`)).body.events).toEqual(
        history(P1, { roles: ['issuer'] }),
      );
      expect((await get(`${historyPath(P1)}?limit=1000&role=`)).body.events).toEqual(history(P1));
    });

    it('event=sale is the sales of the account, as seller, buyer, issuer or broker; filters combine', async () => {
      for (const account of [P1, P2, P3, P4, BUYER, EXTRA_ISSUER, BROKER, c3.issuer]) {
        const res = await get(`${historyPath(account)}?limit=1000&event=sale`);
        expect([account, res.status, res.body.events]).toEqual([account, 200, history(account, { events: ['sale'] })]);
      }
      expect(history(P2, { events: ['sale'] }).length).toBeGreaterThan(0);
      const both = await get(`${historyPath(EXTRA_ISSUER)}?limit=1000&event=mint,sale&role=from`);
      expect(both.body.events).toEqual(history(EXTRA_ISSUER, { events: ['mint', 'sale'], roles: ['from'] }));
      expect(both.body.count).toBe(1);
      // the filters are conditions of the read that is capped: a page of one sale among many events is full
      await expectWalk(api, `${historyPath(P2)}?event=sale`, 'events', history(P2, { events: ['sale'] }), [1]);
      const spy = jest.spyOn(h.ch, 'query');
      await get(`${historyPath(P2)}?event=sale&role=from,to`);
      const [sql] = spy.mock.calls.find(([text]) => isPageRead(String(text))) as [string];
      expect(innerRead(sql)).toContain('event IN {events:Array(String)}');
      expect(innerRead(sql)).toContain('hasAny(roles, {roles:Array(String)})');
      expect(innerRead(sql)).toContain('account = {account:String}');
      expect(sql).not.toMatch(/\bFINAL\b/i);
      // a bad event or role is a 400
      expect((await get(`${historyPath(P2)}?event=nope`)).body).toEqual({ result: 'error', message: 'invalid event' });
    });

    it('an account with two roles in one event appears once, and its filter matches either role', async () => {
      // EXTRA_ISSUER minted the NFT to itself: issuer and to; then sold it: issuer and from
      const roles = (event: string): string[] => [
        ...(rolesOfEvent(committed.find((e) => e.nft_id === SOLD && e.event === event) as Ev).get(EXTRA_ISSUER) ?? []),
      ];
      expect([roles('mint'), roles('sale')]).toEqual([
        ['issuer', 'to'],
        ['issuer', 'from'],
      ]);
      const all = (await get(historyPath(EXTRA_ISSUER))).body.events as Obj[];
      // (it is the issuer of the minter's NFT too: the issuer of a mint is named whoever minted it)
      expect(all.map((e) => [e.event, e.nft_id])).toEqual([
        ['mint', SOLD],
        ['mint', MINTED],
        ['sale', SOLD],
      ]);
      for (const role of ['issuer', 'to', 'from', 'issuer,to', 'issuer,from', 'to,from', 'issuer,to,from']) {
        const res = await get(`${historyPath(EXTRA_ISSUER)}?role=${role}`);
        const want = history(EXTRA_ISSUER, { roles: role.split(',') });
        expect([role, res.body.events]).toEqual([role, want]);
        const keys = (res.body.events as Obj[]).map((e) => `${e.ledger_index}:${e.tx_index}:${e.event_index}`);
        expect([role, new Set(keys).size]).toEqual([role, keys.length]);
      }
      expect((await get(`${historyPath(EXTRA_ISSUER)}?role=issuer,to,from`)).body.count).toBe(3);
      expect((await get(`${historyPath(EXTRA_ISSUER)}?role=to,from`)).body.count).toBe(2);
      // the minter that is not the issuer: minter and to
      const minted = (await get(historyPath(MINTER))).body.events as Obj[];
      expect(minted.map((e) => e.event)).toEqual(['mint']);
      expect((await get(`${historyPath(MINTER)}?role=minter,to`)).body.count).toBe(1);
      expect((await get(`${historyPath(MINTER)}?role=issuer`)).body.count).toBe(0);
      // the offer of SELLER names BUYER as its destination, and SELLER as its owner
      expect((await get(`${historyPath(BUYER)}?role=destination`)).body.events).toEqual(
        history(BUYER, { roles: ['destination'] }),
      );
      expect((await get(`${historyPath(SELLER)}?role=offer_owner`)).body.count).toBe(1);
      // the table has one row for the account and the event, whatever its roles
      const [row] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.AccountNftEvents} WHERE account = {account:String} AND event = 'sale' AND nft_id = {id:String}`,
        { account: EXTRA_ISSUER, id: SOLD },
      );
      expect(Number(row.n)).toBe(1);
    });

    it('a row written twice is served once, and a page cut inside the duplicates neither repeats nor skips an event', async () => {
      const want = history(P3);
      expect(want.length).toBeGreaterThanOrEqual(2);
      expect((await get(`${historyPath(P3)}?limit=1000`)).body.events).toEqual(want);
      await expectWalk(api, historyPath(P3), 'events', want, [1, 2]);
      await expectWalk(api, `${historyPath(P3)}?descending=true`, 'events', [...want].reverse(), [1, 2]);
    });

    it('start and end are dates: the events of the ledgers that closed in the window, the second each names included', async () => {
      const mine = historyOracle(committed, P1);
      const times = [...new Set(mine.map((e) => e.close_time))];
      expect(times.length).toBeGreaterThanOrEqual(3);
      const [a, b] = [times[1], times[2]];
      const served = (query: string): Promise<unknown[]> =>
        get(`${historyPath(P1)}?limit=1000&${query}`).then((r) =>
          (r.body.events as Obj[]).map((e) => [e.ledger_index, e.tx_index]),
        );
      const keys = (list: Ev[]): unknown[] => list.map((e) => [e.ledger_index, e.tx_index]);
      expect(await served(`start=${iso(a)}&end=${iso(b)}`)).toEqual(
        keys(mine.filter((e) => e.close_time >= a && e.close_time <= b)),
      );
      expect(await served(`start=${iso(a + 1)}`)).toEqual(keys(mine.filter((e) => e.close_time > a)));
      expect(await served(`end=${iso(a)}`)).toEqual(keys(mine.filter((e) => e.close_time <= a)));
      expect(await served(`start=${iso(a)}&descending=true`)).toEqual(
        keys(mine.filter((e) => e.close_time >= a)).reverse(),
      );
      // a window with no ledger in it is an empty list with the coverage
      const empty = await get(`${historyPath(P1)}?start=2001-01-01&end=2001-01-02`);
      expect([empty.status, empty.body.count, empty.body.events]).toEqual([200, 0, []]);
      expect(empty.body.coverage).toEqual({ from_ledger_index: FIRST, complete: false });
      // events above the committed head are not served: CUT's transfer to DAVE, and the mint of ABOVE by ALICE
      const aboveIds = made.above.map((e) => e.nft_id);
      for (const account of [ALICE, ...made.above.map((e) => e.to_account)]) {
        const events = (await get(`${historyPath(account)}?limit=1000`)).body.events as Obj[];
        for (const event of events)
          expect(aboveIds.includes(event.nft_id as string) && event.ledger_index === HEAD + 5).toBe(false);
      }
    });

    it('pages with the marker (ledger_index, tx_index, event_index), both ways', async () => {
      const mine = history(P1);
      expect(mine.length).toBeGreaterThanOrEqual(5);
      await expectWalk(api, historyPath(P1), 'events', mine, [1, 2, 3, 7]);
      await expectWalk(api, `${historyPath(P1)}?descending=true`, 'events', [...mine].reverse(), [1, 3]);
      const page = await get(`${historyPath(P1)}?limit=2`);
      const last = (page.body.events as Obj[])[1];
      expect(decodeMarker(page.body.marker)).toEqual([last.ledger_index, last.tx_index, last.event_index]);
      expect(Object.keys(page.body)).toEqual(['result', 'coverage', 'count', 'marker', 'events']);
      await expectWalk(api, `${historyPath(P1)}?role=to`, 'events', history(P1, { roles: ['to'] }), [1, 2]);
    });

    it('answers the errors in the order start, end, event, role, then the marker', async () => {
      const answer = async (query: string): Promise<[number, string]> => {
        const res = await get(`${historyPath(P1)}?${query}`);
        return [res.status, res.body.message];
      };
      expect(await answer(`start=x&end=x&event=x&role=x&marker=${BAD_MARKER}`)).toEqual([
        400,
        'invalid start date format',
      ]);
      expect(await answer(`end=x&event=x&role=x&marker=${BAD_MARKER}`)).toEqual([400, 'invalid end date format']);
      expect(await answer(`event=x&role=x&marker=${BAD_MARKER}`)).toEqual([400, 'invalid event']);
      expect(await answer(`role=x&marker=${BAD_MARKER}`)).toEqual([400, 'invalid role']);
      expect(await answer(`marker=${BAD_MARKER}`)).toEqual([400, 'invalid marker']);
      for (const marker of [
        base64([]),
        base64([1, 2]),
        base64([1, 2, 70_000]),
        base64(['a', 1, 2]),
        base64([-1, 0, 0]),
        'not base64 !',
      ]) {
        expect([marker, await answer(`marker=${encodeURIComponent(marker)}`)]).toEqual([
          marker,
          [400, 'invalid marker'],
        ]);
      }
    });

    it('an X-address and an address with no event have an empty list', async () => {
      for (const account of [X_ADDRESS, owner(99), 'xyz']) {
        const res = await get(historyPath(encodeURIComponent(account)));
        expect([account, res.status, res.body.count, res.body.events]).toEqual([account, 200, 0, []]);
        expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', 'events']);
      }
    });
  });

  // -- the contract ---------------------------------------------------------------------------------------------------------

  describe('the contract of the routes', () => {
    const coverage = { from_ledger_index: FIRST, complete: false };

    it('the NFTs of an account pass the shared list tests: empty, markers concatenate, unknown parameters ignored, CSV and Link, 401', async () => {
      await expectListContract(
        h,
        api,
        {
          name: 'the NFTs',
          path: nftsPath(P1),
          key: 'nfts',
          want: holdings(P1),
          empty: nftsPath(owner(99)),
          csvColumns: NFT_CSV_COLUMNS,
          file: `${P1} - nfts`,
          descending: false,
        },
        coverage,
      );
    });

    it('the NFT history of an account passes the shared list tests: empty, markers concatenate, descending, CSV and Link, 401', async () => {
      await expectListContract(
        h,
        api,
        {
          name: 'the history',
          path: historyPath(P1),
          key: 'events',
          want: history(P1),
          empty: historyPath(owner(99)),
          csvColumns: EVENT_KEYS,
          file: `${P1} - nft history`,
          descending: true,
        },
        coverage,
      );
    });

    it('the CSV of the history has the same columns on every page, and an empty cell where an event has no key', async () => {
      const csv = (await get(`${historyPath(P1)}?format=csv&limit=1000`)).text.split('\n');
      const header = csv[0].split(',');
      expect(header).toEqual(EVENT_KEYS.map((k) => `"${k}"`));
      const fee = header.indexOf('"royalty_est"');
      // a mint has no price, no broker: their cells are empty; every row has the cells of the header
      expect(csv.slice(1).every((row) => row.split(',').length === header.length)).toBe(true);
      expect(csv.slice(1).some((row) => row.split(',')[fee] === '""')).toBe(true);
      // the CSV of the NFTs: the same columns for an NFT with a last_sale and one without
      const nfts = (await get(`${nftsPath(P1)}?format=csv&limit=1000`)).text.split('\n');
      expect(nfts[0].split(',')).toEqual(NFT_CSV_COLUMNS.map((k) => `"${k}"`));
      expect(nfts.slice(1).every((row) => row.split(',').length === NFT_CSV_COLUMNS.length)).toBe(true);
      // an error is not a CSV
      const bad = await get(`${historyPath(P1)}?format=csv&role=nope`);
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid role' }]);
    });

    describe('when the database fails', () => {
      const cases: [string, () => string, string][] = [
        ['the NFTs', () => nftsPath(P1), 'unable to retrieve nfts'],
        ['the NFT history', () => historyPath(P1), 'unable to retrieve nft history'],
      ];

      it.each(cases)('%s is a 500 with its own message, and leaks nothing', async (_name, path, message) => {
        jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
        const res = await get(path());
        expect([res.status, res.body]).toEqual([500, { result: 'error', message }]);
        expect(JSON.stringify(res.body)).not.toContain('boom');
      });
    });
  });
});
