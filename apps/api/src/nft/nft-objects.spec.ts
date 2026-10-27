import { NftEventsRow, NftFold } from '@gatehub/data-api-shared';
import {
  BURNED_AT_KEYS,
  LAST_SALE_KEYS,
  MINTED_KEYS,
  NFT_BODY_KEYS,
  NFT_EVENT_KEYS,
  NFT_EVENTS_BODY_KEYS,
  NFT_KEYS,
  NFT_OFFER_KEYS,
  NFT_OFFERS_BODY_KEYS,
  NFT_SALE_KEYS,
  POINT_KEYS,
  toNftEventCsvRow,
  toNftEventObject,
  toNftObject,
  toNftOfferObject,
  toNftSaleObject,
} from './nft-objects';

const ISSUER = 'rLULtFpQsKRPJwG6NSkpHEyBWmo4YYiEYo';
const ALICE = 'rHciXfDnf4BXsRqTEuvoKmxZWBkxYMRVpt';
const BOB = 'rnKd8CYrXwMoGn4R48onJGLShh1PcrFrTx';
const CAROL = 'rhv9jFwfWfH4Cd1uX4b3ACkdgDKASFz7Dz';
const NFT_ID = '00081388D7A2B1C3E5F70912345678ABCDEF0123456789ABCDEF000000000102';
const URI_TOKEN = '3F2504E04F8911D39A0C0305E82C3301A5C5D5D5E5A5B5C5D5E5F5A5B5C5D5E5';
const HASH = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

/** 2026-10-20T17:01:12Z, in unix seconds. */
const CLOSE = Date.UTC(2026, 9, 20, 17, 1, 12) / 1000;

type Obj = Record<string, unknown>;

/** `keys` are those of `order` that `object` has, in that order: no key is out of place, none is made up. */
function expectOrdered(object: Obj, order: readonly string[]): void {
  const keys = Object.keys(object);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

/** An input must not be changed: the objects are made of frozen rows. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** The fold of an XRPL NFT that was minted, sold and burned... or not: every fact it can hold. */
const FOLD: NftFold = deepFreeze({
  nft_id: NFT_ID,
  kind: 'nftoken',
  issuer: ISSUER,
  taxon: 1,
  taxon_key: 1,
  serial: 4127,
  nft_flags: 8,
  transfer_fee: 5000,
  owner: BOB,
  owner_since: { ledger_index: 107701201, tx_hash: HASH(0x67f9), close_time: CLOSE },
  uri: '697066733A2F2F',
  digest: '',
  minted: { ledger_index: 86201334, tx_hash: HASH(0x1e6b), close_time: CLOSE - 86_400 * 365, by: ISSUER, to: ALICE },
  burned: false,
  sale_count: 7,
  last_sale: {
    ledger_index: 107701201,
    tx_hash: HASH(0x67f9),
    close_time: CLOSE,
    tx_index: 12,
    event_index: 3,
    amount: '1250',
    currency: 'XRP',
    amount_issuer: '',
  },
  first_ledger: 86201334,
  last_ledger: 107701201,
  created_ledger: 86201334,
  owners: [ALICE, BOB],
});

/** The same NFT burned: no owner, no point of ownership, the burn. */
const BURNED: NftFold = deepFreeze({
  ...FOLD,
  owner: '',
  owner_since: undefined,
  burned: true,
  burned_at: { ledger_index: 107800000, tx_hash: HASH(0xb0), close_time: CLOSE + 100, by: ISSUER },
  last_ledger: 107800000,
});

/** A URIToken of Xahau: the id encodes nothing, so there is no taxon, serial or fee; it has a digest. */
const URITOKEN: NftFold = deepFreeze({
  nft_id: URI_TOKEN,
  kind: 'uritoken',
  issuer: ISSUER,
  taxon: null,
  taxon_key: 0,
  serial: 0,
  nft_flags: 1,
  transfer_fee: 0,
  owner: ALICE,
  owner_since: { ledger_index: 26774724, tx_hash: HASH(0x77), close_time: CLOSE },
  uri: '68747470733A2F2F',
  digest: 'AB'.repeat(32),
  burned: false,
  sale_count: 0,
  first_ledger: 26774724,
  last_ledger: 26774724,
  owners: [ALICE],
} as NftFold);

/** An NFT about which no event names an owner or a mint: only a listing. */
const BARE: NftFold = deepFreeze({
  nft_id: NFT_ID,
  kind: 'nftoken',
  issuer: ISSUER,
  taxon: 0,
  taxon_key: 0,
  serial: 0,
  nft_flags: 0,
  transfer_fee: 0,
  owner: '',
  uri: '',
  digest: '',
  burned: false,
  sale_count: 0,
  first_ledger: 107_000_000,
  last_ledger: 107_000_000,
  owners: [],
} as NftFold);

/** A row of `nft_events`: a sale of the NFT above, brokered, in an issued currency. */
const SALE: NftEventsRow = deepFreeze({
  nft_id: NFT_ID,
  ledger_index: 107701201,
  tx_index: 12,
  event_index: 3,
  tx_hash: HASH(0x67f9),
  tx_type: 'NFTokenAcceptOffer',
  close_time: CLOSE,
  kind: 'nftoken',
  event: 'sale',
  issuer: ISSUER,
  taxon: 1,
  taxon_key: 1,
  serial: 4127,
  nft_flags: 8,
  transfer_fee: 5000,
  uri: '',
  digest: '',
  account: CAROL,
  from_account: ALICE,
  to_account: BOB,
  offer_id: HASH(0xf1),
  is_sell_offer: 1,
  amount: '150.5',
  amount_f: 150.5,
  currency: 'USD',
  amount_issuer: CAROL,
  destination: '',
  expiration: null,
  broker: CAROL,
  broker_fee: '2.5',
  royalty_est: '7.4',
  removed_by: '',
});

/** A mint: the least an event holds. */
const MINT: NftEventsRow = deepFreeze({
  ...SALE,
  event_index: 0,
  tx_type: 'NFTokenMint',
  event: 'mint',
  uri: '697066733A2F2F',
  account: ISSUER,
  from_account: '',
  to_account: ALICE,
  offer_id: '',
  is_sell_offer: 0,
  amount: '',
  amount_f: 0,
  currency: '',
  amount_issuer: '',
  broker: '',
  broker_fee: '',
  royalty_est: '',
});

/** A sell offer created by an `NFTokenMint` (a gift: 0 XRP for a destination, expiring). */
const OFFER: NftEventsRow = deepFreeze({
  ...MINT,
  event_index: 1,
  event: 'offer_create',
  uri: '',
  account: ALICE,
  to_account: '',
  offer_id: HASH(0xa1),
  is_sell_offer: 1,
  amount: '0',
  amount_f: 0,
  currency: 'XRP',
  destination: BOB,
  expiration: CLOSE + 7 * 86_400,
});

/** The offer a sale removed. */
const REMOVED: NftEventsRow = deepFreeze({
  ...OFFER,
  tx_type: 'NFTokenAcceptOffer',
  event: 'offer_removed',
  is_sell_offer: 0,
  removed_by: 'sale',
});

/** An event in the uritoken world. */
const URI_MINT: NftEventsRow = deepFreeze({
  ...MINT,
  nft_id: URI_TOKEN,
  kind: 'uritoken',
  taxon: null,
  taxon_key: 0,
  serial: 0,
  transfer_fee: 0,
  digest: 'AB'.repeat(32),
});

describe('the key constants', () => {
  it('are the pinned lists of the spec, in order', () => {
    expect(NFT_KEYS).toEqual([
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
    ]);
    expect(POINT_KEYS).toEqual(['ledger_index', 'tx_hash', 'executed_time']);
    expect(MINTED_KEYS).toEqual(['ledger_index', 'tx_hash', 'executed_time', 'by', 'to']);
    expect(BURNED_AT_KEYS).toEqual(['ledger_index', 'tx_hash', 'executed_time', 'by']);
    expect(LAST_SALE_KEYS).toEqual([
      'amount',
      'currency',
      'amount_issuer',
      'converted_amount',
      'ledger_index',
      'tx_hash',
      'executed_time',
    ]);
    expect(NFT_EVENT_KEYS).toEqual([
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
    ]);
    expect(NFT_SALE_KEYS).toEqual([
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
    ]);
    expect(NFT_OFFER_KEYS).toEqual([
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
    ]);
    expect(NFT_BODY_KEYS).toEqual(['result', 'coverage', 'nft']);
    expect(NFT_EVENTS_BODY_KEYS).toEqual(['result', 'coverage', 'count', 'marker', 'events']);
    expect(NFT_OFFERS_BODY_KEYS).toEqual(['result', 'coverage', 'count', 'marker', 'offers']);
  });
});

describe('toNftObject', () => {
  it('writes the keys of an XRPL NFT in the order of NFT_KEYS, with the values of the fold', () => {
    const nft = toNftObject(FOLD, '1250');
    // (this NFT is not burned and has no digest: the keys of both are out)
    expect(Object.keys(nft)).toEqual(NFT_KEYS.filter((key) => key !== 'digest' && key !== 'burned_at'));
    expect(nft).toEqual({
      nft_id: NFT_ID,
      kind: 'nftoken',
      issuer: ISSUER,
      taxon: 1,
      serial: 4127,
      flags: 8,
      transfer_fee: 5000,
      owner: BOB,
      owner_since: { ledger_index: 107701201, tx_hash: HASH(0x67f9), executed_time: '2026-10-20T17:01:12Z' },
      uri: '697066733A2F2F',
      minted: {
        ledger_index: 86201334,
        tx_hash: HASH(0x1e6b),
        executed_time: '2025-10-20T17:01:12Z',
        by: ISSUER,
        to: ALICE,
      },
      burned: false,
      sale_count: 7,
      last_sale: {
        amount: '1250',
        currency: 'XRP',
        converted_amount: '1250',
        ledger_index: 107701201,
        tx_hash: HASH(0x67f9),
        executed_time: '2026-10-20T17:01:12Z',
      },
    });
  });

  it('the points and the last sale write their keys in their own order', () => {
    const nft = toNftObject(
      { ...FOLD, last_sale: { ...FOLD.last_sale!, amount_issuer: CAROL, currency: 'USD' } },
      '3.5',
    );
    expectOrdered(nft.owner_since as unknown as Obj, POINT_KEYS);
    expectOrdered(nft.minted as unknown as Obj, MINTED_KEYS);
    expect(Object.keys(nft.minted!)).toEqual([...MINTED_KEYS]);
    expect(Object.keys(nft.last_sale!)).toEqual([...LAST_SALE_KEYS]);
    expect(nft.last_sale).toMatchObject({ currency: 'USD', amount_issuer: CAROL, converted_amount: '3.5' });
  });

  it('writes the time of a fact as fmtTime does, in seconds and UTC: owner_since, minted, burned_at and last_sale', () => {
    const nft = toNftObject(
      {
        ...BURNED,
        owner_since: { ledger_index: 1, tx_hash: HASH(1), close_time: Date.UTC(2024, 0, 2, 3, 4, 5) / 1000 },
        minted: { ...FOLD.minted!, close_time: Date.UTC(2022, 10, 1, 0, 0, 0) / 1000 },
        burned_at: { ...BURNED.burned_at!, close_time: Date.UTC(2026, 11, 31, 23, 59, 59) / 1000 },
        last_sale: { ...FOLD.last_sale!, close_time: Date.UTC(2023, 5, 7, 8, 9, 10) / 1000 },
      },
      undefined,
    );
    expect(nft.owner_since?.executed_time).toBe('2024-01-02T03:04:05Z');
    expect(nft.minted?.executed_time).toBe('2022-11-01T00:00:00Z');
    expect(nft.burned_at?.executed_time).toBe('2026-12-31T23:59:59Z');
    expect(nft.last_sale?.executed_time).toBe('2023-06-07T08:09:10Z');
  });

  it('leaves out a last sale conversion that is not known, and the issuer of a price in the native currency', () => {
    const nft = toNftObject(FOLD);
    expect(nft.last_sale).toBeDefined();
    expect(Object.keys(nft.last_sale!)).toEqual(['amount', 'currency', 'ledger_index', 'tx_hash', 'executed_time']);
    // a conversion of '0' is a value
    expect(toNftObject(FOLD, '0').last_sale).toHaveProperty('converted_amount', '0');
  });

  it('a burned NFT has burned true and burned_at, and no owner and no owner_since', () => {
    const nft = toNftObject(BURNED);
    expect(nft.burned).toBe(true);
    expect(nft).not.toHaveProperty('owner');
    expect(nft).not.toHaveProperty('owner_since');
    expect(nft.burned_at).toEqual({
      ledger_index: 107800000,
      tx_hash: HASH(0xb0),
      executed_time: '2026-10-20T17:02:52Z',
      by: ISSUER,
    });
    expect(Object.keys(nft.burned_at!)).toEqual([...BURNED_AT_KEYS]);
    expectOrdered(nft as unknown as Obj, NFT_KEYS);
  });

  it('an NFT of Xahau has no taxon, serial or transfer_fee, and its digest', () => {
    const nft = toNftObject(URITOKEN);
    expect(nft).not.toHaveProperty('taxon');
    expect(nft).not.toHaveProperty('serial');
    expect(nft).not.toHaveProperty('transfer_fee');
    expect(nft).toMatchObject({ kind: 'uritoken', flags: 1, digest: 'AB'.repeat(32), burned: false, sale_count: 0 });
    expectOrdered(nft as unknown as Obj, NFT_KEYS);
    expect(Object.keys(nft)).toEqual([
      'nft_id',
      'kind',
      'issuer',
      'flags',
      'owner',
      'owner_since',
      'uri',
      'digest',
      'burned',
      'sale_count',
    ]);
  });

  it('an XRPL NFT keeps a taxon, serial and transfer_fee of 0: they are values', () => {
    const nft = toNftObject(BARE);
    expect(nft).toMatchObject({ taxon: 0, serial: 0, transfer_fee: 0, flags: 0 });
  });

  it('leaves out what no event names: the owner, the uri, the digest, the mint, the sale', () => {
    const nft = toNftObject(BARE);
    expect(Object.keys(nft)).toEqual([
      'nft_id',
      'kind',
      'issuer',
      'taxon',
      'serial',
      'flags',
      'transfer_fee',
      'burned',
      'sale_count',
    ]);
    expect(nft.burned).toBe(false);
    expect(nft.sale_count).toBe(0);
  });

  it('does not change the fold', () => {
    // the folds are frozen: a write would throw
    expect(() => toNftObject(FOLD, '1')).not.toThrow();
    expect(() => toNftObject(BURNED)).not.toThrow();
  });
});

describe('toNftEventObject', () => {
  it('writes the keys of a sale in the order of NFT_EVENT_KEYS, with the conversion where it is given', () => {
    const event = toNftEventObject(SALE, '12.3');
    expect(event).toEqual({
      nft_id: NFT_ID,
      kind: 'nftoken',
      issuer: ISSUER,
      taxon: 1,
      serial: 4127,
      ledger_index: 107701201,
      tx_index: 12,
      event_index: 3,
      tx_hash: HASH(0x67f9),
      tx_type: 'NFTokenAcceptOffer',
      executed_time: '2026-10-20T17:01:12Z',
      event: 'sale',
      account: CAROL,
      from: ALICE,
      to: BOB,
      offer_id: HASH(0xf1),
      is_sell_offer: true,
      amount: '150.5',
      currency: 'USD',
      amount_issuer: CAROL,
      converted_amount: '12.3',
      broker: CAROL,
      broker_fee: '2.5',
      royalty_est: '7.4',
    });
    expectOrdered(event as unknown as Obj, NFT_EVENT_KEYS);
  });

  it('leaves out every key an event has no value for: a mint is its identity, place, account, to and uri', () => {
    const event = toNftEventObject(MINT);
    expect(Object.keys(event)).toEqual([
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
      'to',
      'uri',
    ]);
  });

  it('is_sell_offer is a boolean, on the events that name an offer, true or false, and absent on the others', () => {
    expect(toNftEventObject(OFFER).is_sell_offer).toBe(true);
    expect(toNftEventObject(REMOVED).is_sell_offer).toBe(false);
    expect(toNftEventObject({ ...OFFER, is_sell_offer: 0 }).is_sell_offer).toBe(false);
    expect(toNftEventObject(MINT)).not.toHaveProperty('is_sell_offer');
    // a transfer through an accepted offer of 0 names the offer, and has no amount
    const transfer = toNftEventObject({
      ...SALE,
      event: 'transfer',
      amount: '',
      currency: '',
      amount_issuer: '',
      broker: '',
      broker_fee: '',
      royalty_est: '',
    });
    expect(transfer.is_sell_offer).toBe(true);
    expect(transfer).not.toHaveProperty('amount');
    expect(transfer).not.toHaveProperty('currency');
    expect(transfer).not.toHaveProperty('converted_amount');
  });

  it('an offer carries its destination and its expiration as a time, and an amount of 0 is a value', () => {
    const offer = toNftEventObject(OFFER);
    expect(offer).toMatchObject({
      event: 'offer_create',
      account: ALICE,
      offer_id: HASH(0xa1),
      amount: '0',
      currency: 'XRP',
      destination: BOB,
      expiration: '2026-10-27T17:01:12Z',
    });
    expect(offer).not.toHaveProperty('amount_issuer');
    expect(offer).not.toHaveProperty('removed_by');
    expectOrdered(offer as unknown as Obj, NFT_EVENT_KEYS);
    expect(toNftEventObject({ ...OFFER, expiration: null })).not.toHaveProperty('expiration');
  });

  it('an offer removed by a sale says by what', () => {
    const removed = toNftEventObject(REMOVED);
    expect(removed).toMatchObject({ event: 'offer_removed', removed_by: 'sale' });
    expectOrdered(removed as unknown as Obj, NFT_EVENT_KEYS);
  });

  it('royalty_est is left out when it is empty and kept when it is 0: a royalty that rounds to nothing', () => {
    expect(toNftEventObject({ ...SALE, royalty_est: '' })).not.toHaveProperty('royalty_est');
    expect(toNftEventObject({ ...SALE, royalty_est: '0' })).toHaveProperty('royalty_est', '0');
    expect(toNftEventObject({ ...SALE, broker: '', broker_fee: '' })).not.toHaveProperty('broker');
    expect(toNftEventObject({ ...SALE, broker: '', broker_fee: '' })).not.toHaveProperty('broker_fee');
  });

  it('an NFT of Xahau has no taxon or serial', () => {
    const event = toNftEventObject(URI_MINT);
    expect(event).not.toHaveProperty('taxon');
    expect(event).not.toHaveProperty('serial');
    expect(event).toMatchObject({ kind: 'uritoken', event: 'mint', nft_id: URI_TOKEN });
    expectOrdered(event as unknown as Obj, NFT_EVENT_KEYS);
  });

  it('an XRPL NFT keeps a taxon and serial of 0', () => {
    expect(toNftEventObject({ ...MINT, taxon: 0, taxon_key: 0, serial: 0 })).toMatchObject({ taxon: 0, serial: 0 });
  });

  it('the conversion is for the sales only', () => {
    expect(toNftEventObject(MINT, '5')).not.toHaveProperty('converted_amount');
    expect(toNftEventObject(OFFER, '5')).not.toHaveProperty('converted_amount');
    expect(toNftEventObject(SALE, '5')).toHaveProperty('converted_amount', '5');
    expect(toNftEventObject(SALE)).not.toHaveProperty('converted_amount');
  });

  it('writes the time of the event as fmtTime does', () => {
    expect(toNftEventObject({ ...MINT, close_time: Date.UTC(2023, 0, 1, 0, 0, 0) / 1000 }).executed_time).toBe(
      '2023-01-01T00:00:00Z',
    );
  });
});

describe('toNftEventCsvRow', () => {
  it('has every column of NFT_EVENT_KEYS in its order, whatever the event holds, null for what it lacks', () => {
    for (const row of [SALE, MINT, OFFER, REMOVED, URI_MINT]) {
      const csv = toNftEventCsvRow(toNftEventObject(row, row.event === 'sale' ? '1' : undefined));
      expect(Object.keys(csv)).toEqual([...NFT_EVENT_KEYS]);
    }
    const mint = toNftEventCsvRow(toNftEventObject(MINT));
    expect(mint.offer_id).toBeNull();
    expect(mint.is_sell_offer).toBeNull();
    expect(mint.account).toBe(ISSUER);
    const sale = toNftEventCsvRow(toNftEventObject(SALE, '12.3'));
    expect(sale.is_sell_offer).toBe(true);
    expect(sale.converted_amount).toBe('12.3');
  });
});

describe('toNftSaleObject', () => {
  it('writes the keys of a brokered sale in the order of NFT_SALE_KEYS: seller, buyer and the mode', () => {
    const sale = toNftSaleObject(SALE, '12.3');
    expect(sale).toEqual({
      nft_id: NFT_ID,
      kind: 'nftoken',
      issuer: ISSUER,
      taxon: 1,
      serial: 4127,
      ledger_index: 107701201,
      tx_index: 12,
      event_index: 3,
      tx_hash: HASH(0x67f9),
      executed_time: '2026-10-20T17:01:12Z',
      seller: ALICE,
      buyer: BOB,
      mode: 'brokered',
      amount: '150.5',
      currency: 'USD',
      amount_issuer: CAROL,
      converted_amount: '12.3',
      broker: CAROL,
      broker_fee: '2.5',
      royalty_est: '7.4',
    });
    expect(Object.keys(sale)).toEqual([...NFT_SALE_KEYS]);
  });

  it('is direct when no broker is set, and then has no broker, broker_fee or royalty_est when they are empty', () => {
    const sale = toNftSaleObject({
      ...SALE,
      broker: '',
      broker_fee: '',
      royalty_est: '',
      amount_issuer: '',
      currency: 'XRP',
    });
    expect(sale.mode).toBe('direct');
    expect(Object.keys(sale)).toEqual([
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
    ]);
  });

  it('a sale of Xahau has no taxon or serial', () => {
    const sale = toNftSaleObject({
      ...URI_MINT,
      event: 'sale',
      from_account: ALICE,
      to_account: BOB,
      amount: '4200',
      currency: 'XAH',
    });
    expect(sale).not.toHaveProperty('taxon');
    expect(sale).not.toHaveProperty('serial');
    expect(sale).toMatchObject({ kind: 'uritoken', seller: ALICE, buyer: BOB, mode: 'direct', amount: '4200' });
  });
});

describe('toNftOfferObject', () => {
  it('writes the keys of an open offer in the order of NFT_OFFER_KEYS, from the event that created it', () => {
    const offer = toNftOfferObject(OFFER);
    expect(offer).toEqual({
      offer_id: HASH(0xa1),
      is_sell_offer: true,
      owner: ALICE,
      amount: '0',
      currency: 'XRP',
      destination: BOB,
      expiration: '2026-10-27T17:01:12Z',
      created_ledger: 107701201,
      created_tx_hash: HASH(0x67f9),
      created_time: '2026-10-20T17:01:12Z',
    });
    expectOrdered(offer as unknown as Obj, NFT_OFFER_KEYS);
  });

  it('is_sell_offer is a boolean also for a buy offer; an offer in an issued currency has its issuer', () => {
    const offer = toNftOfferObject({
      ...OFFER,
      is_sell_offer: 0,
      amount: '10',
      currency: 'USD',
      amount_issuer: CAROL,
      destination: '',
      expiration: null,
    });
    expect(offer.is_sell_offer).toBe(false);
    expect(Object.keys(offer)).toEqual([
      'offer_id',
      'is_sell_offer',
      'owner',
      'amount',
      'currency',
      'amount_issuer',
      'created_ledger',
      'created_tx_hash',
      'created_time',
    ]);
  });
});
