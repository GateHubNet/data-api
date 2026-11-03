import { foldNftEvents, NftEventRead } from './nft-state';

const NFT = '000800005E2C7A6CD9C9A5DB1A2F3E5A3C8A7F1B0000000000000001'.padStart(64, '0');
const ISSUER = 'rIssuer0000000000000000000000000A';
const ALICE = 'rAlice00000000000000000000000000A';
const BOB = 'rBob0000000000000000000000000000A';
const CAROL = 'rCarol00000000000000000000000000A';

/** An event made by hand (its transaction is `synthetic-…`): every column at its absent value unless given. */
function event(over: Partial<NftEventRead> & Pick<NftEventRead, 'event' | 'ledger_index'>): NftEventRead {
  const tx_index = over.tx_index ?? 0;
  return {
    nft_id: NFT,
    tx_index,
    event_index: 0,
    tx_hash: `synthetic-${over.ledger_index}-${tx_index}-${over.event_index ?? 0}`,
    close_time: 1_700_000_000 + over.ledger_index,
    kind: 'nftoken',
    issuer: ISSUER,
    taxon: 7,
    taxon_key: 7,
    serial: 1,
    nft_flags: 8,
    transfer_fee: 5000,
    uri: '',
    digest: '',
    account: '',
    from_account: '',
    to_account: '',
    amount: '',
    currency: '',
    amount_issuer: '',
    ...over,
  };
}

const mint = (ledger_index: number, to = ALICE, over: Partial<NftEventRead> = {}): NftEventRead =>
  event({ event: 'mint', ledger_index, account: ISSUER, to_account: to, uri: 'AAAA', ...over });
const sale = (ledger_index: number, from: string, to: string, over: Partial<NftEventRead> = {}): NftEventRead =>
  event({
    event: 'sale',
    ledger_index,
    account: to,
    from_account: from,
    to_account: to,
    amount: '12.5',
    currency: 'XRP',
    ...over,
  });
const transfer = (ledger_index: number, from: string, to: string): NftEventRead =>
  event({ event: 'transfer', ledger_index, account: from, from_account: from, to_account: to });
const burn = (ledger_index: number, from: string, by = from): NftEventRead =>
  event({ event: 'burn', ledger_index, account: by, from_account: from });
const offer = (ledger_index: number, name: NftEventRead['event'] = 'offer_create'): NftEventRead =>
  event({ event: name, ledger_index, account: BOB, amount: '1', currency: 'XRP' });

const point = (e: NftEventRead) => ({ ledger_index: e.ledger_index, tx_hash: e.tx_hash, close_time: e.close_time });

describe('foldNftEvents', () => {
  it('mint, sale, transfer: the owner, owner_since, sale_count, last_sale and owners', () => {
    const events = [
      mint(100),
      sale(110, ALICE, BOB, { tx_index: 3, event_index: 2, amount: '40', currency: 'USD', amount_issuer: 'rGate' }),
      transfer(120, BOB, CAROL),
    ];
    const fold = foldNftEvents(events);
    expect(fold).toEqual({
      nft_id: NFT,
      kind: 'nftoken',
      issuer: ISSUER,
      taxon: 7,
      taxon_key: 7,
      serial: 1,
      nft_flags: 8,
      transfer_fee: 5000,
      owner: CAROL,
      owner_since: point(events[2]),
      uri: 'AAAA',
      digest: '',
      minted: { ...point(events[0]), by: ISSUER, to: ALICE },
      burned: false,
      sale_count: 1,
      last_sale: {
        ...point(events[1]),
        tx_index: 3,
        event_index: 2,
        amount: '40',
        currency: 'USD',
        amount_issuer: 'rGate',
      },
      first_ledger: 100,
      last_ledger: 120,
      created_ledger: 100,
      owners: [ALICE, BOB, CAROL],
    });
    expect(fold).not.toHaveProperty('burned_at');
  });

  it('counts every sale and keeps the newest as last_sale', () => {
    const fold = foldNftEvents([
      mint(100),
      sale(110, ALICE, BOB, { amount: '1' }),
      sale(120, BOB, ALICE, { amount: '2' }),
      sale(130, ALICE, CAROL, { amount: '3', event_index: 4 }),
    ]);
    expect(fold.sale_count).toBe(3);
    expect(fold.last_sale).toMatchObject({ ledger_index: 130, tx_index: 0, event_index: 4, amount: '3' });
    expect(fold.owners).toEqual([ALICE, BOB, CAROL]);
  });

  it('a burn clears the owner and records burned_at', () => {
    const events = [mint(100), burn(150, ALICE, ISSUER)];
    const fold = foldNftEvents(events);
    expect(fold.owner).toBe('');
    expect(fold.owner_since).toBeUndefined();
    expect(fold.burned).toBe(true);
    expect(fold.burned_at).toEqual({ ...point(events[1]), by: ISSUER });
    expect(fold.minted).toEqual({ ...point(events[0]), by: ISSUER, to: ALICE });
    expect(fold.owners).toEqual([ALICE]);
    expect(fold.last_ledger).toBe(150);
  });

  it('a modify or an offer after a burn leaves it burned', () => {
    const fold = foldNftEvents([
      mint(100),
      burn(150, ALICE),
      event({ event: 'modify', ledger_index: 160, uri: 'BBBB' }),
      offer(170),
    ]);
    expect(fold.burned).toBe(true);
    expect(fold.burned_at).toMatchObject({ ledger_index: 150, by: ALICE });
    expect(fold.owner).toBe('');
    expect(fold.uri).toBe('BBBB');
  });

  it('a re-mint after a burn gives the NFT an owner again', () => {
    const events = [mint(100, ALICE), sale(110, ALICE, BOB), burn(150, BOB), mint(200, CAROL, { uri: 'CCCC' })];
    const fold = foldNftEvents(events);
    expect(fold.burned).toBe(false);
    expect(fold).not.toHaveProperty('burned_at');
    expect(fold.owner).toBe(CAROL);
    expect(fold.owner_since).toEqual(point(events[3]));
    expect(fold.minted).toEqual({ ...point(events[3]), by: ISSUER, to: CAROL });
    expect(fold.uri).toBe('CCCC');
    // the first life's owners are kept, the sale still counts
    expect(fold.owners).toEqual([ALICE, BOB, CAROL]);
    expect(fold.sale_count).toBe(1);
    expect(fold.first_ledger).toBe(100);
    expect(fold.created_ledger).toBe(100);
  });

  it('folds an NFT whose mint is not indexed', () => {
    const sold = foldNftEvents([sale(500, ALICE, BOB), transfer(510, BOB, CAROL)]);
    expect(sold.owner).toBe(CAROL);
    expect(sold.owners).toEqual([ALICE, BOB, CAROL]);
    expect(sold.minted).toBeUndefined();
    expect(sold.created_ledger).toBeUndefined();
    expect(sold.first_ledger).toBe(500);

    const firstSale = foldNftEvents([sale(500, ALICE, BOB)]);
    expect(firstSale.owner).toBe(BOB);
    expect(firstSale.owner_since).toMatchObject({ ledger_index: 500 });
    expect(firstSale.owners).toEqual([ALICE, BOB]);
    expect(firstSale).not.toHaveProperty('minted');
    expect(firstSale).not.toHaveProperty('created_ledger');

    const offersOnly = foldNftEvents([offer(600), offer(610, 'offer_cancel')]);
    expect(offersOnly.owner).toBe('');
    expect(offersOnly.owner_since).toBeUndefined();
    expect(offersOnly.owners).toEqual([]);
    expect(offersOnly.burned).toBe(false);
    expect(offersOnly.sale_count).toBe(0);
    expect(offersOnly.last_sale).toBeUndefined();
    expect(offersOnly.minted).toBeUndefined();
    expect(offersOnly.created_ledger).toBeUndefined();
    expect(offersOnly).toMatchObject({ issuer: ISSUER, taxon_key: 7, serial: 1, first_ledger: 600, last_ledger: 610 });
  });

  it('the newest modify sets the uri', () => {
    const fold = foldNftEvents([
      mint(100, ALICE, { uri: 'AAAA' }),
      event({ event: 'modify', ledger_index: 110, uri: 'BBBB' }),
      event({ event: 'modify', ledger_index: 120, uri: 'CCCC' }),
      sale(130, ALICE, BOB),
    ]);
    expect(fold.uri).toBe('CCCC');
    // a modify names no owner
    expect(fold.owner).toBe(BOB);
    expect(fold.owners).toEqual([ALICE, BOB]);
  });

  it('offer events move first_ledger and last_ledger only', () => {
    const events = [
      offer(90, 'offer_create'),
      mint(100),
      offer(110, 'offer_create'),
      offer(120, 'offer_removed'),
      offer(130, 'offer_cancel'),
    ];
    const fold = foldNftEvents(events);
    expect(fold.first_ledger).toBe(90);
    expect(fold.last_ledger).toBe(130);
    expect(fold.owner).toBe(ALICE);
    expect(fold.owner_since).toEqual(point(events[1]));
    expect(fold.minted).toMatchObject({ ledger_index: 100 });
    expect(fold.owners).toEqual([ALICE]);
    expect(fold.sale_count).toBe(0);
    expect(fold.uri).toBe('AAAA');
    // the first event is an offer, not a mint
    expect(fold.created_ledger).toBeUndefined();
  });

  it("created_ledger is the first event's ledger when that event is a mint", () => {
    expect(foldNftEvents([mint(100), sale(110, ALICE, BOB)]).created_ledger).toBe(100);
    expect(foldNftEvents([sale(110, ALICE, BOB), mint(120)]).created_ledger).toBeUndefined();
    expect(foldNftEvents([mint(100), burn(110, ALICE), mint(120)]).created_ledger).toBe(100);
  });

  it('owners are each account once, first seen first, sellers before buyers', () => {
    const fold = foldNftEvents([
      mint(100, ALICE),
      sale(110, ALICE, BOB),
      transfer(120, BOB, ALICE),
      sale(130, ALICE, CAROL),
      burn(140, CAROL),
    ]);
    expect(fold.owners).toEqual([ALICE, BOB, CAROL]);
  });

  it('reads the Xahau URIToken digest and kind', () => {
    const fold = foldNftEvents([
      event({
        event: 'mint',
        kind: 'uritoken',
        ledger_index: 10,
        to_account: ALICE,
        account: ALICE,
        uri: 'AB',
        digest: 'D1',
        taxon: null,
        taxon_key: 0,
        serial: 0,
        nft_flags: 1,
        transfer_fee: 0,
      }),
      event({
        event: 'transfer',
        kind: 'uritoken',
        ledger_index: 20,
        from_account: ALICE,
        to_account: BOB,
        account: ALICE,
        digest: 'D1',
        taxon: null,
        taxon_key: 0,
        serial: 0,
        nft_flags: 1,
        transfer_fee: 0,
      }),
    ]);
    expect(fold).toMatchObject({
      kind: 'uritoken',
      taxon: null,
      taxon_key: 0,
      serial: 0,
      digest: 'D1',
      uri: 'AB',
      owner: BOB,
    });
  });

  it('refuses an empty list', () => {
    expect(() => foldNftEvents([])).toThrow(RangeError);
  });

  it('does not change its input', () => {
    const events = Object.freeze([mint(100), sale(110, ALICE, BOB)].map((e) => Object.freeze(e)));
    expect(() => foldNftEvents(events)).not.toThrow();
  });
});
