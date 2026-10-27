import { NativeRatesDailyRow, NftKind, RATES_DAILY_CONFIG_VERSION } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { accountAt, iso } from './amm';
import { nftEventRow } from './nfts';
import { compareKeys, Ev, nftOf, Obj, offerIdOf, present, Slot, synthId, World } from './nfts-oracle';

/**
 * What the collection suite (`nft-collections`) checks the collection routes against: collections made by hand (their
 * transactions say `synthetic-…`) for what the recordings do not hold (ties in every sort, a collection of burned NFTs, a holder
 * who gives up everything, sales in an issued currency with and without a rate), and an oracle in plain JavaScript over events:
 * a collection's facts, the objects the routes serve and the days of its stats, none of it from the code under test.
 */

/** An account of the collections made by hand. */
export const owner = (n: number): string => accountAt(0x500 + n);
const BROKER = accountAt(0x77);
/** The issuer of the issued currencies the sales are priced in. */
export const USD_ISSUER = accountAt(0x61);
export const JPY_ISSUER = accountAt(0x62);

/** The UTC day of a time in unix seconds, `YYYY-MM-DD`. */
export const dayOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

// =====================================================================================================================
// The collections made by hand

/** The key of a collection. */
export interface Key {
  issuer: string;
  taxon_key: number;
}
export const idOfKey = (k: Key): string => `${k.issuer}/${k.taxon_key}`;

/** The collections made by hand for a network: three issuers with three, two and one taxons on XRPL, one issuer each on Xahau. */
export function syntheticKeys(world: World): Key[] {
  const issuers = Array.from({ length: 8 }, (_, i) => accountAt(0x300 + i));
  return world.kind === 'nftoken'
    ? [
        { issuer: issuers[0], taxon_key: 1 },
        { issuer: issuers[0], taxon_key: 2 },
        { issuer: issuers[0], taxon_key: 3 },
        { issuer: issuers[1], taxon_key: 1 },
        { issuer: issuers[1], taxon_key: 2 },
        { issuer: issuers[2], taxon_key: 5 },
        { issuer: issuers[3], taxon_key: 1 },
        { issuer: issuers[4], taxon_key: 1 },
      ]
    : issuers.map((issuer) => ({ issuer, taxon_key: 0 }));
}

/** The rate of an asset on a day, units of the asset for one native coin: what `native_rates_daily` is seeded with. */
export interface RateSeed {
  currency: string;
  issuer: string;
  day: string;
  rate: string;
}

/** The rows of `native_rates_daily` of some rates, as the `rates_daily` job writes a set: a sentinel, then an asset each. */
export function rateRows(rates: RateSeed[]): NativeRatesDailyRow[] {
  const row = (currency: string, issuer: string, day: string, rate: string): NativeRatesDailyRow => ({
    currency,
    issuer,
    day,
    rate,
    rate_f: Number(rate),
    daily_count: 0,
    latest_count: 0,
    config_version: RATES_DAILY_CONFIG_VERSION,
    stale: 0,
    version: 1,
  });
  const days = [...new Set(rates.map((r) => r.day))];
  return [...days.map((day) => row('', '', day, '0')), ...rates.map((r) => row(r.currency, r.issuer, r.day, r.rate))];
}

/**
 * The events of the collections made by hand, and the rates they are priced with. The `first` batch is in ledgers before the
 * newest of the seed; the `second` is in the newest, after the aggregates were built over the first: a holder gives up all it
 * held, an NFT is burned, an NFT is sold on, so that every aggregate has older and newer versions of its rows.
 *
 *  - c0: 3 NFTs, 2 holders, one sale of 100; then its holder P1 gives up its NFT: P2 holds all 3.
 *  - c1: 3 NFTs, 3 holders, two sales of 60 and 40 (a volume of 100, as c0's was).
 *  - c2: 5 NFTs, 3 holders (two of them with two each), no sale.
 *  - c3: 1 NFT, 1 holder, three sales: 250.5, 7000 JPY (no rate: it counts and has no price) and 3 brokered.
 *  - c4: 5 NFTs, 2 holders, a sale of 40 USD at a rate of 4 (a price of 10); then one NFT is burned.
 *  - c5: 2 NFTs, 2 holders, no sale; then a sale of 5 moves an NFT from P2 to P1 (one holder).
 *  - c6: 3 NFTs, one burned.
 *  - c7: 2 NFTs, both burned.
 */
export function syntheticCollections(
  world: World,
  slots: Slot[],
): { keys: Key[]; first: Ev[]; second: Ev[]; rates: RateSeed[] } {
  const xrpl = world.kind === 'nftoken';
  const keys = syntheticKeys(world);
  /** Where the events are: spread over the days of the seed, the first batch before the newest ledger. */
  const early = slots[0];
  const middle = slots[Math.floor(slots.length / 2)];
  const late = slots[slots.length - 2];
  const newest = slots[slots.length - 1];
  let tx = 5000;
  let offer = 0;

  const nft = (c: number, j: number): Partial<Ev> => ({
    nft_id: synthId(0x100000 + c * 100 + j),
    kind: xrpl ? 'nftoken' : 'uritoken',
    issuer: keys[c].issuer,
    taxon: xrpl ? keys[c].taxon_key : null,
    taxon_key: keys[c].taxon_key,
    // (scrambled, so that the order of the serials is not the order of the ids)
    serial: xrpl ? ((j * 7919) % 97) + 1 : 0,
    nft_flags: xrpl ? 8 : 1,
    transfer_fee: xrpl ? 5000 : 0,
  });
  const event = (c: number, j: number, slot: Slot, over: Partial<Ev>): Ev =>
    nftEventRow({
      ...nft(c, j),
      ledger_index: slot.index,
      close_time: slot.close,
      tx_index: tx++,
      event_index: 0,
      uri: '',
      account: '',
      from_account: '',
      to_account: '',
      royalty_est: '',
      ...over,
    });
  const mint = (c: number, j: number, slot: Slot, to: string): Ev =>
    event(c, j, slot, {
      tx_type: xrpl ? 'NFTokenMint' : 'URITokenMint',
      event: 'mint',
      account: keys[c].issuer,
      to_account: to,
      uri: '697066733A2F2F6D696E74',
      digest: xrpl ? '' : 'CD'.repeat(32),
    });
  const sale = (
    c: number,
    j: number,
    slot: Slot,
    from: string,
    to: string,
    amount: string,
    asset: { currency: string; issuer: string } = { currency: world.native, issuer: '' },
    over: Partial<Ev> = {},
  ): Ev => {
    offer += 1;
    return event(c, j, slot, {
      tx_type: xrpl ? 'NFTokenAcceptOffer' : 'URITokenBuy',
      event: 'sale',
      account: to,
      from_account: from,
      to_account: to,
      offer_id: xrpl ? offerIdOf(0x7000 + offer) : synthId(0x100000 + c * 100 + j),
      is_sell_offer: 1,
      amount,
      amount_f: Number(amount),
      currency: asset.currency,
      amount_issuer: asset.issuer,
      royalty_est: xrpl ? '0.5' : '',
      ...over,
    });
  };
  const burn = (c: number, j: number, slot: Slot, by: string): Ev =>
    event(c, j, slot, {
      tx_type: xrpl ? 'NFTokenBurn' : 'URITokenBurn',
      event: 'burn',
      account: by,
      from_account: by,
    });
  const transfer = (c: number, j: number, slot: Slot, from: string, to: string): Ev =>
    event(c, j, slot, {
      tx_type: xrpl ? 'NFTokenAcceptOffer' : 'Remit',
      event: 'transfer',
      account: from,
      from_account: from,
      to_account: to,
    });

  const [P1, P2, P3, P4, P5] = [owner(1), owner(2), owner(3), owner(4), owner(5)];
  const usd = { currency: 'USD', issuer: USD_ISSUER };
  const jpy = { currency: 'JPY', issuer: JPY_ISSUER };

  const first: Ev[] = [
    // c0: P1 and P2 hold three; the first is sold to P2 for 100
    mint(0, 0, early, P1),
    mint(0, 1, early, P1),
    mint(0, 2, middle, P2),
    sale(0, 0, middle, P1, P2, '100'),
    // c1: three holders, two sales
    mint(1, 0, early, P1),
    mint(1, 1, early, P2),
    mint(1, 2, middle, P3),
    sale(1, 1, middle, P2, P4, '60'),
    sale(1, 2, late, P3, P5, '40'),
    // c2: five NFTs, three holders, two of them with the same number
    ...[P1, P1, P2, P2, P3].map((to, j) => mint(2, j, early, to)),
    // c3: one NFT sold three times
    mint(3, 0, early, P1),
    sale(3, 0, early, P1, P2, '250.5'),
    sale(3, 0, middle, P2, P3, '7000', jpy),
    sale(3, 0, late, P3, P4, '3', undefined, { broker: BROKER, broker_fee: '0.5', royalty_est: xrpl ? '0.25' : '' }),
    // c4: five NFTs, one sold for 40 USD
    ...[P1, P2, P1, P2, P1].map((to, j) => mint(4, j, early, to)),
    sale(4, 0, middle, P1, P2, '40', usd),
    // c5: two NFTs
    mint(5, 0, middle, P1),
    mint(5, 1, late, P2),
    // c6: three NFTs, one burned
    mint(6, 0, early, P1),
    mint(6, 1, early, P2),
    mint(6, 2, middle, P3),
    burn(6, 2, late, P3),
    // c7: two NFTs, both burned
    mint(7, 0, early, P1),
    mint(7, 1, middle, P2),
    burn(7, 0, late, P1),
    burn(7, 1, late, P2),
  ];

  const second: Ev[] = [
    // c0: P1 gives up its NFT: the holders are P2 alone, and P1's row says it holds nothing
    transfer(0, 1, newest, P1, P2),
    // c4: P1's third NFT is burned: the older row of the NFT says it is not
    burn(4, 4, newest, P1),
    // c5: P2's NFT is sold to P1: P2's older row says it holds it
    sale(5, 1, newest, P2, P1, '5'),
  ];

  const rates: RateSeed[] = [{ currency: usd.currency, issuer: usd.issuer, day: dayOf(middle.close), rate: '4' }];
  return { keys, first, second, rates };
}

// =====================================================================================================================
// The oracle

/** The rates of the assets by day: `${currency}+${issuer}@${day}`. */
export type Rates = Map<string, BigNumber>;
export const ratesOf = (seeds: RateSeed[]): Rates =>
  new Map(seeds.map((r) => [`${r.currency}+${r.issuer}@${r.day}`, new BigNumber(r.rate)]));

/**
 * The price of a sale in the native currency, `undefined` when it has none: a price in the native currency is itself, one in
 * an issued currency is divided by the rate of its asset on the UTC day of the sale and rounded to the 6th decimal (half up).
 */
export function priceOf(e: Ev, rates: Rates): BigNumber | undefined {
  if (e.amount_issuer === '') return new BigNumber(e.amount);
  const rate = rates.get(`${e.currency}+${e.amount_issuer}@${dayOf(e.close_time)}`);
  return rate === undefined || rate.isZero()
    ? undefined
    : new BigNumber(e.amount).dividedBy(rate).decimalPlaces(6, BigNumber.ROUND_HALF_UP);
}

/** The text of a price as the API writes it. */
export const priceText = (price: BigNumber | undefined): string | undefined => price?.toFixed();

/** Everything the routes serve of a collection, worked out from its events. */
export interface Facts {
  key: Key;
  kind: NftKind;
  taxon: number | null;
  /** The events of the collection, oldest first. */
  events: Ev[];
  /** The events of each NFT, oldest first. */
  nfts: Map<string, Ev[]>;
}

/** The collections of a set of events (by NFT, each list oldest first), by `idOfKey`. */
export function collectionsOf(byNft: Map<string, Ev[]>): Map<string, Facts> {
  const out = new Map<string, Facts>();
  for (const [id, list] of byNft) {
    const head = list[0];
    const key = { issuer: head.issuer, taxon_key: head.taxon_key };
    let facts = out.get(idOfKey(key));
    if (!facts) {
      facts = { key, kind: head.kind, taxon: head.kind === 'nftoken' ? head.taxon : null, events: [], nfts: new Map() };
      out.set(idOfKey(key), facts);
    }
    facts.nfts.set(id, list);
    facts.events.push(...list);
  }
  for (const facts of out.values()) facts.events.sort(compareKeys);
  return out;
}

/** The NFTs of a collection as the API serves them in a list (by serial, then id), with the burned ones if asked for. */
export function nftsOfCollection(facts: Facts, includeBurned = false, ownedBy?: string): Obj[] {
  return [...facts.nfts.values()]
    .map((list) => ({ list, nft: nftOf(list, () => undefined) }))
    .filter(({ nft }) => includeBurned || nft.burned === false)
    .filter(({ nft }) => ownedBy === undefined || nft.owner === ownedBy)
    .sort(
      (a, b) =>
        ((a.nft.serial as number | undefined) ?? 0) - ((b.nft.serial as number | undefined) ?? 0) ||
        ((a.nft.nft_id as string) < (b.nft.nft_id as string) ? -1 : 1),
    )
    .map(({ nft }) => nft);
}

/** How many NFTs each owner holds of a collection: the current owners of the NFTs that are not burned. */
export function holdersOfCollection(facts: Facts): Array<{ owner: string; held: number }> {
  const held = new Map<string, number>();
  for (const list of facts.nfts.values()) {
    const nft = nftOf(list);
    if (nft.burned === false && typeof nft.owner === 'string') held.set(nft.owner, (held.get(nft.owner) ?? 0) + 1);
  }
  return [...held.entries()]
    .map(([ownerAddress, count]) => ({ owner: ownerAddress, held: count }))
    .sort((a, b) => b.held - a.held || (a.owner < b.owner ? -1 : 1));
}

/** The sales of a collection, oldest first. */
export const salesOfCollection = (facts: Facts): Ev[] => facts.events.filter((e) => e.event === 'sale');

/** A sale as the API serves it. */
export function saleOf(e: Ev, rates: Rates): Obj {
  const xrpl = e.kind === 'nftoken';
  return present({
    nft_id: e.nft_id,
    kind: e.kind,
    issuer: e.issuer,
    taxon: xrpl ? e.taxon : undefined,
    serial: xrpl ? e.serial : undefined,
    ledger_index: e.ledger_index,
    tx_index: e.tx_index,
    event_index: e.event_index,
    tx_hash: e.tx_hash,
    executed_time: iso(e.close_time),
    seller: e.from_account,
    buyer: e.to_account,
    mode: e.broker !== '' ? 'brokered' : 'direct',
    amount: e.amount,
    currency: e.currency,
    amount_issuer: e.amount_issuer,
    converted_amount: priceText(priceOf(e, rates)),
    broker: e.broker,
    broker_fee: e.broker_fee,
    royalty_est: e.royalty_est,
  });
}

/** A collection as the API serves it. */
export function collectionOf(facts: Facts, rates: Rates): Obj {
  const mints = facts.events.filter((e) => e.event === 'mint');
  const point = (e: Ev): Obj => ({
    ledger_index: e.ledger_index,
    tx_hash: e.tx_hash,
    executed_time: iso(e.close_time),
  });
  const states = [...facts.nfts.values()].map((list) => nftOf(list));
  const volume = salesOfCollection(facts).reduce((sum, e) => sum.plus(priceOf(e, rates) ?? 0), new BigNumber(0));
  return present({
    issuer: facts.key.issuer,
    taxon: facts.kind === 'nftoken' ? (facts.taxon ?? undefined) : undefined,
    kind: facts.kind,
    supply: states.filter((s) => s.burned === false).length,
    holders: holdersOfCollection(facts).length,
    minted: mints.length,
    burned: facts.events.filter((e) => e.event === 'burn').length,
    sales_count: salesOfCollection(facts).length,
    volume_native: volume.toFixed(),
    first_mint: mints.length > 0 ? point(mints[0]) : undefined,
    last_mint: mints.length > 0 ? point(mints[mints.length - 1]) : undefined,
    last_ledger: facts.events[facts.events.length - 1].ledger_index,
  });
}

/** The sort values of the list: what a collection is ordered by. */
export type Sort = 'volume' | 'supply' | 'holders';
const SORT_KEY: Record<Sort, (c: Obj) => number> = {
  volume: (c) => Number(c.volume_native),
  supply: (c) => c.supply as number,
  holders: (c) => c.holders as number,
};

/** The collections as the list serves them: by the sort, the ties by issuer and then taxon ascending, whichever way it runs. */
export function sortedCollections(collections: Obj[], sort: Sort, descending: boolean): Obj[] {
  const value = SORT_KEY[sort];
  return [...collections].sort(
    (a, b) =>
      (descending ? value(b) - value(a) : value(a) - value(b)) ||
      ((a.issuer as string) < (b.issuer as string) ? -1 : (a.issuer as string) > (b.issuer as string) ? 1 : 0) ||
      ((a.taxon as number | undefined) ?? 0) - ((b.taxon as number | undefined) ?? 0),
  );
}

/**
 * The days of a collection's stats: a row for each UTC day with a sale, a mint or a burn among the events of the window. The
 * average is the volume over the sales that have a price, rounded to the 6th decimal (half up); the day has no price fields when
 * none of its sales does.
 */
export function daysOf(events: Ev[], rates: Rates): Obj[] {
  const days = new Map<string, Ev[]>();
  for (const e of events) {
    if (e.event !== 'sale' && e.event !== 'mint' && e.event !== 'burn') continue;
    const day = dayOf(e.close_time);
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, list]) => {
      const sales = list.filter((e) => e.event === 'sale');
      const prices = sales.map((e) => priceOf(e, rates)).filter((p): p is BigNumber => p !== undefined);
      const volume = prices.reduce((sum, p) => sum.plus(p), new BigNumber(0));
      return present({
        date: `${day}T00:00:00Z`,
        sales_count: sales.length,
        volume_native: volume.toFixed(),
        avg_price_native:
          prices.length > 0
            ? volume.dividedBy(prices.length).decimalPlaces(6, BigNumber.ROUND_HALF_UP).toFixed()
            : undefined,
        min_price_native: prices.length > 0 ? BigNumber.minimum(...prices).toFixed() : undefined,
        mints: list.filter((e) => e.event === 'mint').length,
        burns: list.filter((e) => e.event === 'burn').length,
      });
    });
}
