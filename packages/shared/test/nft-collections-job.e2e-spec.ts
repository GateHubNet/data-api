import BigNumber from 'bignumber.js';
import {
  collectionsBehind,
  NFT_COLLECTIONS_BATCH,
  NftCollectionsRecomputeAborted,
  recomputeCollections,
} from '../src/aggregate/nft-collections.job';
import { CollectionKey, nftsChangedSince, rebuildNfts } from '../src/aggregate/nft-state.job';
import { RATES_DAILY_CONFIG_VERSION } from '../src/aggregate/rates-daily.job';
import { computeDailyVolumeSet } from '../src/aggregate/volume.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { NativeRatesDailyRow, NftEventsRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { MarketsConfig } from '../src/network';
import { Asset } from '../src/query/asset';
import { DailyRates } from '../src/query/daily-rates';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The `nft_collections` job's functions on a real ClickHouse (spec 1.2, 3.2): `recomputeCollections` writes the holders of a
 * collection and its `nft_collections` row, `collectionsBehind` names the collections to compute.
 *
 * The world is made by hand (every transaction says `synthetic-…`): the events are written to the tables an ingest writes them
 * to, the NFTs are rebuilt by the real `rebuildNfts`, and what the job wrote is read back as a reader reads it, the newest
 * version of a key, without FINAL. The prices in the native currency are `nftSalesNativeSql`'s (Task 10), and the volume of a
 * collection is compared with the components of the `nft_volume` daily sets of the same sales.
 */

const DAY = 86_400;
/** Day 0 of the world: 2026-01-10 00:00:00 UTC. */
const BASE = Date.UTC(2026, 0, 10) / 1000;
/** The close time of ledger `n` in the worlds that do not care about the day: a minute into day 0 plus the ledger. */
const T0 = BASE + 60;
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;

const ISSUER = 'rSyntheticIssuer';
const OTHER_ISSUER = 'rSyntheticOtherIssuer';
const ALICE = 'rSyntheticAlice';
const BOB = 'rSyntheticBob';
const CAROL = 'rSyntheticCarol';
const COLLECTION: CollectionKey = { issuer: ISSUER, taxon_key: 7 };
const OTHER: CollectionKey = { issuer: OTHER_ISSUER, taxon_key: 1 };

const ISSUING = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const USD: Asset = { currency: 'USD', issuer: ISSUING };
const EUR: Asset = { currency: 'EUR', issuer: ISSUING };

const idOf = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');
const serialOf = (id: string): number => Number.parseInt(id.slice(-8), 16);

/** An event made by hand: only what is given is set, the rest is absent. The collection is `COLLECTION` unless it says. */
function event(over: Partial<NftEventsRow> & Pick<NftEventsRow, 'nft_id' | 'ledger_index' | 'event'>): NftEventsRow {
  const tx_index = over.tx_index ?? 0;
  return {
    tx_index,
    event_index: 0,
    tx_hash: `synthetic-${over.ledger_index}-${tx_index}`,
    tx_type: 'NFTokenMint',
    close_time: T0 + over.ledger_index,
    kind: 'nftoken',
    issuer: ISSUER,
    taxon: 7,
    taxon_key: 7,
    serial: serialOf(over.nft_id),
    nft_flags: 8,
    transfer_fee: 0,
    uri: '',
    digest: '',
    account: '',
    from_account: '',
    to_account: '',
    offer_id: '',
    is_sell_offer: 0,
    amount: '',
    amount_f: 0,
    currency: '',
    amount_issuer: '',
    destination: '',
    expiration: null,
    broker: '',
    broker_fee: '',
    royalty_est: '',
    removed_by: '',
    ...over,
  };
}

const mint = (n: number, ledger: number, to: string, over: Partial<NftEventsRow> = {}): NftEventsRow =>
  event({
    nft_id: idOf(n),
    ledger_index: ledger,
    event: 'mint',
    account: ISSUER,
    to_account: to,
    uri: 'AAAA',
    ...over,
  });
const burn = (n: number, ledger: number, from: string, over: Partial<NftEventsRow> = {}): NftEventsRow =>
  event({ nft_id: idOf(n), ledger_index: ledger, event: 'burn', account: from, from_account: from, ...over });
const offer = (n: number, ledger: number, owner: string, over: Partial<NftEventsRow> = {}): NftEventsRow =>
  event({
    nft_id: idOf(n),
    ledger_index: ledger,
    event: 'offer_create',
    account: owner,
    is_sell_offer: 1,
    offer_id: idOf(ledger),
    amount: '9',
    amount_f: 9,
    currency: 'XRP',
    ...over,
  });
/** A sale of an NFT for `amount` of `currency` (an issued asset has its issuer). */
const sale = (
  n: number,
  ledger: number,
  from: string,
  to: string,
  amount: string,
  price: 'XRP' | Asset = 'XRP',
  over: Partial<NftEventsRow> = {},
): NftEventsRow =>
  event({
    nft_id: idOf(n),
    ledger_index: ledger,
    event: 'sale',
    tx_type: 'NFTokenAcceptOffer',
    account: to,
    from_account: from,
    to_account: to,
    amount,
    amount_f: Number(amount),
    currency: price === 'XRP' ? 'XRP' : price.currency,
    amount_issuer: price === 'XRP' ? '' : (price.issuer as string),
    ...over,
  });

/** The collection of an event, as the fields of an event say it. */
const inCollection = (key: CollectionKey): Partial<NftEventsRow> => ({
  issuer: key.issuer,
  taxon: key.taxon_key,
  taxon_key: key.taxon_key,
});

interface StoredCollection {
  issuer: string;
  taxon_key: number;
  kind: string;
  taxon: number | null;
  supply: number;
  holders: number;
  minted: number;
  burned: number;
  sales_count: number;
  volume_native: string;
  volume_native_f: number;
  first_mint_ledger: number | null;
  first_mint_tx: string;
  first_mint_time: string | null;
  last_mint_ledger: number | null;
  last_mint_tx: string;
  last_mint_time: string | null;
  last_ledger: number;
  version: number;
}

interface StoredHolder {
  owner: string;
  held: number;
  version: number;
}

const KEY = 'issuer, taxon_key';

/** The set of a day of `native_rates_daily` as the rates job writes it: a sentinel and the assets with a rate (units per native coin). */
function ratesSet(seconds: number, rates: Array<[Asset, string]>): NativeRatesDailyRow[] {
  const row = (currency: string, issuer: string, rate: string): NativeRatesDailyRow => ({
    currency,
    issuer,
    day: new Date(seconds * 1000).toISOString().slice(0, 10),
    rate,
    rate_f: Number(rate),
    daily_count: 0,
    latest_count: 0,
    config_version: RATES_DAILY_CONFIG_VERSION,
    stale: 0,
    version: 1,
  });
  return [row('', '', '0'), ...rates.map(([asset, rate]) => row(asset.currency, asset.issuer as string, rate))];
}

describe('the nft_collections job (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  interface World {
    ch: ClickHouseService;
    rates: RatesService;
    daily: DailyRates;
  }

  /** A migrated database of its own. */
  async function fresh(): Promise<World> {
    const config = { ...container.config, database: `nft_collections_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const ch = new ClickHouseService(config);
    services.push(ch);
    const rates = new RatesService(ch, 'XRP');
    return { ch, rates, daily: new DailyRates(ch, rates) };
  }

  /**
   * The events in the tables an ingest writes them to (the NFT's, the collection's, the sales and the touches), and, when
   * `commit`, the `ledgers` row of every ledger of them, closed when its first event was (the commit marker).
   */
  async function insertEvents(ch: ClickHouseService, rows: NftEventsRow[], commit = true): Promise<void> {
    await ch.insert(Table.NftEvents, rows);
    await ch.insert(Table.CollectionNftEvents, rows);
    await ch.insert(
      Table.NftSales,
      rows.filter((r) => r.event === 'sale'),
    );
    const touches = new Map(rows.map((r) => [`${r.ledger_index}:${r.tx_index}:${r.nft_id}`, r]));
    await ch.insert(
      Table.NftTouches,
      [...touches.values()].map(({ ledger_index, tx_index, nft_id, issuer, taxon_key, serial }) => ({
        ledger_index,
        tx_index,
        nft_id,
        issuer,
        taxon_key,
        serial,
      })),
    );
    if (commit) {
      const closes = new Map<number, number>();
      for (const r of rows) if (!closes.has(r.ledger_index)) closes.set(r.ledger_index, r.close_time);
      await ch.insert(
        Table.Ledgers,
        [...closes].map(([ledger_index, close_time]) => ({
          ledger_index,
          ledger_hash: `${ledger_index}`.padStart(64, 'C'),
          close_time,
        })),
      );
    }
  }

  /** `nft_state`'s work, in one go: every NFT with a touch above what its row has seen is rebuilt. */
  async function rebuildStale(ch: ClickHouseService): Promise<CollectionKey[]> {
    const { nfts } = await nftsChangedSince(ch, 0, 10_000);
    return (await rebuildNfts(ch, nfts)).collections;
  }

  /** The newest version of each collection, as a reader sees it. */
  async function collectionsOf(ch: ClickHouseService): Promise<StoredCollection[]> {
    const rows = await ch.query<Record<string, string | number | null>>(
      `SELECT issuer, taxon_key, kind, taxon, supply, holders, minted, burned, sales_count, volume_native, volume_native_f,
              first_mint_ledger, first_mint_tx, toUnixTimestamp(first_mint_time) AS first_mint_time,
              last_mint_ledger, last_mint_tx, toUnixTimestamp(last_mint_time) AS last_mint_time, last_ledger, version
         FROM ${Table.NftCollections} ORDER BY ${KEY}, version DESC LIMIT 1 BY ${KEY}`,
    );
    const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
    return rows.map(
      (r): StoredCollection => ({
        issuer: r.issuer as string,
        taxon_key: Number(r.taxon_key),
        kind: r.kind as string,
        taxon: num(r.taxon),
        supply: Number(r.supply),
        holders: Number(r.holders),
        minted: Number(r.minted),
        burned: Number(r.burned),
        sales_count: Number(r.sales_count),
        volume_native: r.volume_native as string,
        volume_native_f: Number(r.volume_native_f),
        first_mint_ledger: num(r.first_mint_ledger),
        first_mint_tx: r.first_mint_tx as string,
        first_mint_time: r.first_mint_time === null ? null : String(r.first_mint_time),
        last_mint_ledger: num(r.last_mint_ledger),
        last_mint_tx: r.last_mint_tx as string,
        last_mint_time: r.last_mint_time === null ? null : String(r.last_mint_time),
        last_ledger: Number(r.last_ledger),
        version: Number(r.version),
      }),
    );
  }

  async function collectionOf(ch: ClickHouseService, key: CollectionKey): Promise<StoredCollection> {
    const found = (await collectionsOf(ch)).find((c) => c.issuer === key.issuer && c.taxon_key === key.taxon_key);
    if (!found) throw new Error(`no nft_collections row for ${key.issuer}/${key.taxon_key}`);
    return found;
  }

  /** Every row of a collection's holders, the newest version of each owner (a reader drops the ones with `held` 0). */
  async function holderRowsOf(ch: ClickHouseService, key: CollectionKey): Promise<StoredHolder[]> {
    const rows = await ch.query<StoredHolder>(
      `SELECT owner, held, toUInt64(version) AS version
         FROM (SELECT owner, held, version FROM ${Table.NftCollectionHolders}
                WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32}
                ORDER BY ${KEY}, owner, version DESC LIMIT 1 BY ${KEY}, owner)
        ORDER BY owner`,
      { ...key },
    );
    return rows.map((r) => ({ owner: r.owner, held: Number(r.held), version: Number(r.version) }));
  }

  /** What a reader lists: the newest row of each owner, those with `held` above 0. */
  async function holdersOf(ch: ClickHouseService, key: CollectionKey): Promise<Array<[string, number]>> {
    return (await holderRowsOf(ch, key)).filter((h) => h.held > 0).map((h) => [h.owner, h.held]);
  }

  const count = async (ch: ClickHouseService, table: Table, where = '1'): Promise<number> =>
    Number((await ch.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${table} WHERE ${where}`))?.n);

  /** Stops the merges of a table of the database of `ch`, so that rows written twice stay twice. */
  async function stopMerges(ch: ClickHouseService, table: Table): Promise<void> {
    const db = await ch.queryOne<{ db: string }>('SELECT currentDatabase() AS db');
    await ch.command(`SYSTEM STOP MERGES ${db?.db}.${table}`);
  }

  /** A collection of four NFTs: three held (Alice 1, Bob 2), one burned, one sale of 5 XRP, and an offer. */
  const BASIC: NftEventsRow[] = [
    mint(1, 100, ALICE),
    mint(2, 101, ALICE),
    mint(3, 102, BOB),
    mint(4, 103, ALICE),
    offer(1, 104, ALICE),
    sale(2, 105, ALICE, BOB, '5'),
    burn(4, 110, ALICE),
  ];

  it('supply is minted minus burned when every event is indexed', async () => {
    const { ch, daily } = await fresh();
    await insertEvents(ch, BASIC);
    await rebuildStale(ch);

    const result = await recomputeCollections(ch, daily, [COLLECTION]);
    expect(result).toEqual({ written: 1, removed: 0 });

    const row = await collectionOf(ch, COLLECTION);
    expect(row).toMatchObject({
      issuer: ISSUER,
      taxon_key: 7,
      kind: 'nftoken',
      taxon: 7,
      minted: 4,
      burned: 1,
      supply: 3,
      sales_count: 1,
      volume_native: '5',
      volume_native_f: 5,
      // the oldest and the newest mint, with the transaction and the close time of each
      first_mint_ledger: 100,
      first_mint_tx: 'synthetic-100-0',
      first_mint_time: String(T0 + 100),
      last_mint_ledger: 103,
      last_mint_tx: 'synthetic-103-0',
      last_mint_time: String(T0 + 103),
      // the newest event of the collection: the burn
      last_ledger: 110,
    });
    expect(row.supply).toBe(row.minted - row.burned);
  });

  it('counts holders and writes the holders set', async () => {
    const { ch, daily } = await fresh();
    await insertEvents(ch, BASIC);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [COLLECTION]);

    // Alice holds NFT 1 (NFT 2 was sold, NFT 4 burned), Bob NFTs 2 and 3
    expect(await holdersOf(ch, COLLECTION)).toEqual([
      [ALICE, 1],
      [BOB, 2],
    ]);
    expect((await collectionOf(ch, COLLECTION)).holders).toBe(2);
    // the holders were written under the version of the collection row
    const version = (await collectionOf(ch, COLLECTION)).version;
    expect((await holderRowsOf(ch, COLLECTION)).map((h) => h.version)).toEqual([version, version]);
  });

  it('writes held 0 for a holder that is gone, which a reader drops', async () => {
    const { ch, daily } = await fresh();
    await insertEvents(ch, BASIC);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [COLLECTION]);
    const first = await collectionOf(ch, COLLECTION);

    // Bob sells both of his NFTs to Carol, who also buys Alice's
    await insertEvents(ch, [
      sale(2, 120, BOB, CAROL, '6'),
      sale(3, 121, BOB, CAROL, '7'),
      sale(1, 122, ALICE, CAROL, '8'),
    ]);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [COLLECTION]);

    expect(await holdersOf(ch, COLLECTION)).toEqual([[CAROL, 3]]);
    const rows = await holderRowsOf(ch, COLLECTION);
    // the owners of the newest set who are gone have a row of their own that says 0, under the new version
    expect(rows.map((h) => [h.owner, h.held])).toEqual([
      [ALICE, 0],
      [BOB, 0],
      [CAROL, 3],
    ]);
    const second = await collectionOf(ch, COLLECTION);
    expect(second.holders).toBe(1);
    expect(second.sales_count).toBe(4);
    expect(second.volume_native).toBe('26');
    expect(second.last_ledger).toBe(122);
    expect(second.version).toBeGreaterThan(first.version);
    expect(rows.every((h) => h.version === second.version)).toBe(true);

    // and once Carol too is gone (her NFTs burned), the set is empty, and the zero rows stay for the next reader
    await insertEvents(ch, [burn(1, 130, CAROL), burn(2, 131, CAROL), burn(3, 132, CAROL)]);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [COLLECTION]);
    expect(await holdersOf(ch, COLLECTION)).toEqual([]);
    expect(await collectionOf(ch, COLLECTION)).toMatchObject({ holders: 0, supply: 0, minted: 4, burned: 4 });
  });

  it('counts an unrated sale in sales_count and not in volume_native', async () => {
    const { ch, daily } = await fresh();
    await insertEvents(ch, [
      mint(1, 100, ALICE),
      mint(2, 101, ALICE),
      mint(3, 102, ALICE),
      sale(1, 110, ALICE, BOB, '5'),
      // 2 USD: the world has no rate for the asset that day, so the sale has no price in the native currency
      sale(2, 111, ALICE, BOB, '2', USD),
      sale(3, 112, ALICE, BOB, '0.000001'),
    ]);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [COLLECTION]);

    expect(await collectionOf(ch, COLLECTION)).toMatchObject({
      sales_count: 3,
      volume_native: '5.000001',
      volume_native_f: 5.000001,
    });
  });

  it('writes volume_native as plain decimal text, with no exponent and no trailing zeros', async () => {
    const { ch, daily } = await fresh();
    await insertEvents(ch, [
      mint(1, 100, ALICE),
      mint(2, 101, ALICE),
      mint(3, 102, ALICE),
      sale(1, 110, ALICE, BOB, '100000000000000000000000'),
      sale(2, 111, ALICE, BOB, '0.5'),
      sale(3, 112, ALICE, BOB, '0.25'),
    ]);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [COLLECTION]);

    const row = await collectionOf(ch, COLLECTION);
    expect(row.volume_native).toBe('100000000000000000000000.75');
    expect(row.volume_native).toMatch(/^\d+(\.\d*[1-9])?$/);
    expect(row.volume_native_f).toBe(Number('100000000000000000000000.75'));

    // a collection with nothing sold has the text 0
    await insertEvents(ch, [mint(9, 200, ALICE, inCollection(OTHER))]);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [OTHER]);
    expect(await collectionOf(ch, OTHER)).toMatchObject({ sales_count: 0, volume_native: '0', volume_native_f: 0 });
  });

  it('volume_native equals the sum of the nft_volume daily components over the same sales', async () => {
    const { ch, rates, daily } = await fresh();
    const markets: MarketsConfig = { version: 1, tradeMarkets: [], paymentCurrencies: [] };
    const X = COLLECTION;
    const Y = OTHER;
    const Z: CollectionKey = { issuer: 'rSyntheticUriIssuer', taxon_key: 0 };
    const inX = inCollection(X);
    const inY = inCollection(Y);
    const inZ: Partial<NftEventsRow> = { issuer: Z.issuer, taxon: null, taxon_key: 0, kind: 'uritoken' };
    const at = (day: number, seconds: number): number => BASE + day * DAY + seconds;
    // three days of sales: ledgers 1000 to 1999 are day 0, 2000 to 2999 day 1, 3000 to 3999 day 2
    const sold = (
      n: number,
      ledger: number,
      day: number,
      amount: string,
      price: 'XRP' | Asset,
      over: Partial<NftEventsRow>,
    ) => sale(n, ledger, ALICE, BOB, amount, price, { close_time: at(day, 3600 + ledger), ...over });
    const events: NftEventsRow[] = [
      mint(1, 10, ALICE, { ...inX, close_time: at(-1, 100) }),
      mint(2, 11, ALICE, { ...inY, close_time: at(-1, 101) }),
      mint(3, 12, ALICE, { ...inZ, close_time: at(-1, 102) }),
      // day 0: 10 XRP, 2 USD at 2 USD per XRP (1 XRP), and 3 XRP in another collection
      sold(1, 1000, 0, '10', 'XRP', inX),
      sold(1, 1001, 0, '2', USD, inX),
      sold(2, 1002, 0, '3', 'XRP', inY),
      // day 1: a millionth, 7 EUR at 3 EUR per XRP (2.333333 XRP: rounded to 6 places), and a URIToken sale
      sold(1, 2000, 1, '0.000001', 'XRP', inX),
      sold(1, 2001, 1, '7', EUR, inX),
      sold(3, 2002, 1, '4.5', 'XRP', inZ),
      // day 2 has no rate set: the USD sale of Y is unrated, the XRP sale of X is not
      sold(2, 3000, 2, '1', USD, inY),
      sold(1, 3001, 2, '5', 'XRP', inX),
    ];
    // (a later day's ledger so that the days before it are final)
    events.push(mint(4, 5000, ALICE, { ...inX, close_time: at(4, 0) }));
    await insertEvents(ch, events);
    await ch.insert(Table.NativeRatesDaily, [...ratesSet(at(0, 0), [[USD, '2']]), ...ratesSet(at(1, 0), [[EUR, '3']])]);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [X, Y, Z]);

    for (const day of [0, 1, 2])
      await computeDailyVolumeSet(ch, rates, markets, 'nft_volume', new Date(at(day, 0) * 1000));

    // the components of the days, as a reader lists them: the newest version of each day's set
    const components = await ch.query<{ component: string; amount: string; count: number | string }>(
      `SELECT component, amount, count FROM ${Table.VolumeDaily}
        WHERE metric = 'nft_volume' AND component != ''
          AND (day, version) IN (SELECT day, max(version) FROM ${Table.VolumeDaily} WHERE metric = 'nft_volume' GROUP BY day)
        ORDER BY day, component`,
    );
    const sums = new Map<string, BigNumber>();
    for (const c of components) sums.set(c.component, (sums.get(c.component) ?? new BigNumber(0)).plus(c.amount));
    expect([...sums.keys()].sort()).toEqual([`${X.issuer}/7`, `${Y.issuer}/1`, Z.issuer].sort());

    // 10 + 1 + 0.000001 + 2.333333 + 5 for X, 3 for Y (the USD sale of day 2 has no rate), 4.5 for Z
    expect(sums.get(`${X.issuer}/7`)?.toFixed()).toBe('18.333334');
    expect(sums.get(`${Y.issuer}/1`)?.toFixed()).toBe('3');
    expect(sums.get(Z.issuer)?.toFixed()).toBe('4.5');
    for (const key of [X, Y, Z]) {
      const id = key.taxon_key === 0 ? key.issuer : `${key.issuer}/${key.taxon_key}`;
      const row = await collectionOf(ch, key);
      expect(row.volume_native).toBe((sums.get(id) as BigNumber).toFixed());
      expect(row.volume_native_f).toBe((sums.get(id) as BigNumber).toNumber());
    }
    // every sale is in the count, the unrated one too
    expect((await collectionOf(ch, X)).sales_count).toBe(5);
    expect((await collectionOf(ch, Y)).sales_count).toBe(2);
    expect((await collectionOf(ch, Z)).sales_count).toBe(1);
  });

  it('takes kind and taxon from the NFTs: a URIToken collection has no taxon', async () => {
    const { ch, daily } = await fresh();
    const uri: Partial<NftEventsRow> = { issuer: 'rSyntheticUriIssuer', taxon: null, taxon_key: 0, kind: 'uritoken' };
    await insertEvents(ch, [
      mint(1, 100, ALICE, uri),
      mint(2, 101, BOB, uri),
      burn(1, 102, ALICE, uri),
      mint(1, 103, BOB, uri),
    ]);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [{ issuer: 'rSyntheticUriIssuer', taxon_key: 0 }]);
    expect(await collectionOf(ch, { issuer: 'rSyntheticUriIssuer', taxon_key: 0 })).toMatchObject({
      kind: 'uritoken',
      taxon: null,
      taxon_key: 0,
      // a token that was burned and minted again counts both its mints
      minted: 3,
      burned: 1,
      supply: 2,
    });
  });

  it('deletes a collection with no NFT left from both tables', async () => {
    const { ch, daily } = await fresh();
    await insertEvents(ch, [...BASIC, mint(9, 150, BOB, inCollection(OTHER))]);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [COLLECTION, OTHER]);
    expect(await count(ch, Table.NftCollections)).toBe(2);
    expect(await count(ch, Table.NftCollectionHolders, `issuer = '${ISSUER}'`)).toBe(2);

    // a re-ingest drops every event of the collection: its NFTs are removed, and then the collection
    for (const table of [Table.NftEvents, Table.CollectionNftEvents, Table.NftSales, Table.NftTouches]) {
      await ch.command(
        `DELETE FROM ${table} WHERE issuer = {issuer:String}`,
        { issuer: ISSUER },
        { settings: SYNC_DELETE },
      );
    }
    const touched = await rebuildNfts(
      ch,
      [1, 2, 3, 4].map((n) => ({ issuer: ISSUER, taxon_key: 7, serial: n, nft_id: idOf(n) })),
    );
    expect(touched.removed).toBe(4);
    expect(touched.collections).toEqual([COLLECTION]);

    const result = await recomputeCollections(ch, daily, [COLLECTION, OTHER]);
    expect(result).toEqual({ written: 1, removed: 1 });
    expect(await count(ch, Table.NftCollections, `issuer = '${ISSUER}'`)).toBe(0);
    expect(await count(ch, Table.NftCollectionHolders, `issuer = '${ISSUER}'`)).toBe(0);
    // the other collection is still there, with its holder
    expect((await collectionsOf(ch)).map((c) => c.issuer)).toEqual([OTHER_ISSUER]);
    expect(await holdersOf(ch, OTHER)).toEqual([[BOB, 1]]);

    // asked again, it has nothing to remove; a collection that never had a row is nothing to do either
    expect(await recomputeCollections(ch, daily, [COLLECTION, { issuer: 'rSyntheticNobody', taxon_key: 3 }])).toEqual({
      written: 0,
      removed: 0,
    });

    // and when the collection comes back, it is written again from nothing
    await insertEvents(ch, [mint(1, 300, CAROL)]);
    await rebuildStale(ch);
    await recomputeCollections(ch, daily, [COLLECTION]);
    expect(await holdersOf(ch, COLLECTION)).toEqual([[CAROL, 1]]);
    expect(await collectionOf(ch, COLLECTION)).toMatchObject({ minted: 1, supply: 1, holders: 1 });
  });

  it('collectionsBehind names the collections an NFT rebuild made stale', async () => {
    const { ch, daily } = await fresh();
    expect(await collectionsBehind(ch)).toEqual([]);

    await insertEvents(ch, [...BASIC, mint(9, 150, BOB, inCollection(OTHER))]);
    await rebuildStale(ch);
    // two collections with NFTs and no row of their own, in key order
    expect(await collectionsBehind(ch)).toEqual([COLLECTION, OTHER]);

    await recomputeCollections(ch, daily, [COLLECTION]);
    expect(await collectionsBehind(ch)).toEqual([OTHER]);
    await recomputeCollections(ch, daily, [OTHER]);
    expect(await collectionsBehind(ch)).toEqual([]);

    // an NFT of one of them changes: that collection is behind again, and only that one
    await insertEvents(ch, [sale(3, 200, BOB, ALICE, '2')]);
    await rebuildStale(ch);
    expect(await collectionsBehind(ch)).toEqual([COLLECTION]);
    await recomputeCollections(ch, daily, [COLLECTION]);
    expect(await collectionsBehind(ch)).toEqual([]);
  });

  it('writes its rows under a version above the newest of every key it rewrites, the holders too', async () => {
    const { ch, daily } = await fresh();
    await insertEvents(ch, BASIC);
    await rebuildStale(ch);
    // rows from a future clock: of the collection, of a holder it has now, and of one that is gone
    const future = Date.now() + 10 * 365 * DAY * 1000;
    await ch.insert(Table.NftCollections, [
      {
        issuer: ISSUER,
        taxon_key: 7,
        kind: 'nftoken',
        taxon: 7,
        supply: 99,
        holders: 99,
        minted: 99,
        burned: 0,
        sales_count: 0,
        volume_native: '0',
        volume_native_f: 0,
        first_mint_ledger: null,
        first_mint_tx: '',
        first_mint_time: null,
        last_mint_ledger: null,
        last_mint_tx: '',
        last_mint_time: null,
        last_ledger: 1,
        version: future + 10,
      },
    ]);
    await ch.insert(Table.NftCollectionHolders, [
      { issuer: ISSUER, taxon_key: 7, owner: ALICE, held: 50, version: future + 20 },
      { issuer: ISSUER, taxon_key: 7, owner: CAROL, held: 5, version: future + 30 },
    ]);

    await recomputeCollections(ch, daily, [COLLECTION]);

    // the newest row of every key is the one just written: Alice's count is the real one, Carol's is gone
    expect(await holdersOf(ch, COLLECTION)).toEqual([
      [ALICE, 1],
      [BOB, 2],
    ]);
    const rows = await holderRowsOf(ch, COLLECTION);
    expect(rows.find((h) => h.owner === CAROL)).toMatchObject({ held: 0 });
    const row = await collectionOf(ch, COLLECTION);
    expect(row).toMatchObject({ supply: 3, holders: 2, minted: 4 });
    expect(row.version).toBeGreaterThan(future + 30);
    expect(rows.every((h) => h.version === row.version)).toBe(true);
  });

  it('reads only committed ledgers and each event once', async () => {
    const { ch, daily } = await fresh();
    await stopMerges(ch, Table.CollectionNftEvents);
    await insertEvents(ch, BASIC);
    // the same events written again (a table written twice is not collapsed before a merge; an identical block would be dropped)
    await ch.command(
      `INSERT INTO ${Table.CollectionNftEvents} SELECT * FROM ${Table.CollectionNftEvents}`,
      {},
      { settings: { insert_deduplicate: 0 } },
    );
    expect(await count(ch, Table.CollectionNftEvents)).toBe(BASIC.length * 2);
    await rebuildStale(ch);
    // a sale and a mint above the newest committed ledger: their rows are there, their `ledgers` row is not
    await insertEvents(ch, [sale(1, 900, ALICE, BOB, '40'), mint(5, 901, ALICE)], false);

    await recomputeCollections(ch, daily, [COLLECTION]);
    expect(await collectionOf(ch, COLLECTION)).toMatchObject({
      minted: 4,
      burned: 1,
      sales_count: 1,
      volume_native: '5',
      last_ledger: 110,
    });
  });

  it('writes nothing once its signal is aborted', async () => {
    const { ch, daily } = await fresh();
    await insertEvents(ch, BASIC);
    await rebuildStale(ch);
    const controller = new AbortController();
    controller.abort();
    await expect(recomputeCollections(ch, daily, [COLLECTION], { signal: controller.signal })).rejects.toThrow(
      NftCollectionsRecomputeAborted,
    );
    expect(await count(ch, Table.NftCollections)).toBe(0);
    expect(await count(ch, Table.NftCollectionHolders)).toBe(0);
  });

  it('writes nothing while no ledger is committed, and for no collection', async () => {
    const { ch, daily } = await fresh();
    expect(await recomputeCollections(ch, daily, [])).toEqual({ written: 0, removed: 0 });
    expect(await recomputeCollections(ch, daily, [COLLECTION])).toEqual({ written: 0, removed: 0 });
    expect(await count(ch, Table.NftCollections)).toBe(0);
  });

  it('takes a batch of NFT_COLLECTIONS_BATCH collections at a time, each in its own row', async () => {
    expect(NFT_COLLECTIONS_BATCH).toBe(50);
    const { ch, daily } = await fresh();
    const keys: CollectionKey[] = Array.from({ length: NFT_COLLECTIONS_BATCH }, (_, i) => ({
      issuer: `rSyntheticIssuer${String(i).padStart(2, '0')}`,
      taxon_key: i % 3,
    }));
    await insertEvents(
      ch,
      keys.flatMap((key, i) => [
        mint(i + 1, 100 + i, ALICE, inCollection(key)),
        mint(i + 101, 100 + i, i % 2 === 0 ? ALICE : BOB, { ...inCollection(key), tx_index: 1 }),
      ]),
    );
    await rebuildStale(ch);
    expect(await recomputeCollections(ch, daily, [...keys].reverse())).toEqual({
      written: NFT_COLLECTIONS_BATCH,
      removed: 0,
    });
    const rows = await collectionsOf(ch);
    expect(rows.map((r) => [r.issuer, r.taxon_key])).toEqual(keys.map((k) => [k.issuer, k.taxon_key]));
    expect(rows.every((r) => r.minted === 2 && r.supply === 2)).toBe(true);
    // one version for the batch
    expect(new Set(rows.map((r) => r.version)).size).toBe(1);
    expect(rows.map((r) => r.holders)).toEqual(keys.map((_, i) => (i % 2 === 0 ? 1 : 2)));
  });
});
