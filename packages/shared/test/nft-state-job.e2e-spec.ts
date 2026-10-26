import { join } from 'node:path';
import {
  deleteNftDirty,
  markNftDirty,
  narrowNftDirty,
  NFT_STATE_BATCH,
  nftDirtyLedgers,
  NftDirtyRange,
  NftKey,
  NftRebuildAborted,
  nftsChangedSince,
  nftsInLedgers,
  nftStateWatermark,
  oldestNftDirty,
  rebuildNfts,
} from '../src/aggregate/nft-state.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { AccountNftsRow, NftEventsRow, NftsRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The `nft_state` job's functions on a real ClickHouse.
 *
 * Part 1 rebuilds every NFT of the recorded XRPL ledgers (`fixtures/xrpl/nft`, written through the real `LedgerWriter`) and
 * compares each with an oracle that reads the events in plain JavaScript, plus the sale and the burn of two of them, and
 * the Xahau URITokens (a token burned and minted again among them). Part 2 is the rebuild on events made by hand (their
 * transactions are `synthetic-…`): the removal of an NFT, the versions, the abort, the head. Part 3 is what to rebuild:
 * `nftsChangedSince`, `nftStateWatermark`, `nftsInLedgers`. Part 4 is the `nft_dirty` queue.
 */

const T0 = 1_700_000_000;
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;

const xrplCtx = parseContextFor(getNetworkProfile('xrpl'));
const xahauCtx = parseContextFor(getNetworkProfile('xahau'));
const XRPL_LEDGERS = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/nft')).list();
const XRPL_EVENTS: NftEventsRow[] = XRPL_LEDGERS.flatMap((raw) => buildLedgerRows(raw, xrplCtx).nftEvents);
const XAHAU_LEDGERS = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xahau/uritoken')).list();
const XAHAU_EVENTS: NftEventsRow[] = XAHAU_LEDGERS.flatMap((raw) => buildLedgerRows(raw, xahauCtx).nftEvents);

// Recorded NFTs (see test/fixtures/xrpl/nft/FINDINGS.md): a direct sale of 10 XRP, and a burn that removes the NFT's offer.
const SOLD = '00081388EA968E3C54EE59C8FFBAF0944A3B8AD4797AB032EF22952605AD2A91';
const SELLER = 'rhv9jFwfWfH4Cd1uX4b3ACkdgDKASFz7Dz';
const BUYER = 'rnKd8CYrXwMoGn4R48onJGLShh1PcrFrTx';
const BURNED = '00081388CFF1C6E01236757983B2F73D2A57B94FB165D29473F38DB90663D71D';
const BURNER = 'rKxWWCEDrwTWn9A8QxgKDW4VhwuCcd8W7f';
// A recorded URIToken that was burned and minted again 11 ledgers later, and one that was sold for 0.0011 EVR.
const REMINTED = '85E8A5D9F1E086D72B86CEB076CF3CBF1D8358C846ED112D024173E536EC2773';
const REMINTER = 'rSEaE7FEQ5b2z2CRdCs9SvXzuTHs2wB8L';
const SOLD_URITOKEN = '494E26BE7766A7DB12912C51055C0106DA39401BF2E60E86611FD00E48CDE99F';

// Events made by hand: 64 upper-case hex digits for an id, accounts and transactions named synthetic.
const ISSUER = 'rSyntheticIssuer';
const ALICE = 'rSyntheticAlice';
const BOB = 'rSyntheticBob';
const CAROL = 'rSyntheticCarol';
const idOf = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

/** An event made by hand: only what is given is set, the rest is absent. */
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
    serial: Number.parseInt(over.nft_id.slice(-8), 16),
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

const mint = (id: string, ledger: number, to: string, over: Partial<NftEventsRow> = {}): NftEventsRow =>
  event({ nft_id: id, ledger_index: ledger, event: 'mint', account: ISSUER, to_account: to, uri: 'AAAA', ...over });
const sale = (id: string, ledger: number, from: string, to: string, over: Partial<NftEventsRow> = {}): NftEventsRow =>
  event({
    nft_id: id,
    ledger_index: ledger,
    event: 'sale',
    account: to,
    from_account: from,
    to_account: to,
    amount: '5',
    amount_f: 5,
    currency: 'XRP',
    ...over,
  });
const burn = (id: string, ledger: number, from: string, over: Partial<NftEventsRow> = {}): NftEventsRow =>
  event({ nft_id: id, ledger_index: ledger, event: 'burn', account: from, from_account: from, ...over });

const keyOf = (id: string): NftKey => ({
  issuer: ISSUER,
  taxon_key: 7,
  serial: Number.parseInt(id.slice(-8), 16),
  nft_id: id,
});

/** A `ledgers` row: just enough to commit the ledger (the marker the writer writes after the rows of a ledger). */
const ledgerRow = (ledger_index: number) => ({
  ledger_index,
  ledger_hash: `${ledger_index}`.padStart(64, 'C'),
  close_time: T0 + ledger_index,
});

const byNftId = (a: NftKey, b: NftKey): number => (a.nft_id < b.nft_id ? -1 : a.nft_id > b.nft_id ? 1 : 0);

type StoredNft = Omit<NftsRow, 'version'> & { version: number };
type StoredHolding = Omit<AccountNftsRow, 'version'> & { version: number };

const KEY = 'issuer, taxon_key, serial, nft_id';

/** What a reader sees: the newest version of each NFT, without FINAL. */
async function latestNfts(ch: ClickHouseService): Promise<StoredNft[]> {
  const rows = await ch.query<NftsRow>(`SELECT * FROM ${Table.Nfts} ORDER BY ${KEY}, version DESC LIMIT 1 BY ${KEY}`);
  return rows.map((r) => ({ ...r, version: Number(r.version) }));
}

/** The newest version of each (owner, NFT): the holdings are the ones with `held` 1. */
async function latestHoldings(ch: ClickHouseService): Promise<StoredHolding[]> {
  const rows = await ch.query<AccountNftsRow>(
    `SELECT * FROM ${Table.AccountNfts} ORDER BY owner, ${KEY}, version DESC LIMIT 1 BY owner, ${KEY}`,
  );
  return rows.map((r) => ({ ...r, version: Number(r.version) }));
}

const withoutVersion = <T extends { version: number }>(rows: T[]): Array<Omit<T, 'version'>> =>
  rows.map(({ version: _version, ...row }) => row);

describe('the nft_state job (e2e)', () => {
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

  /** A migrated database of its own. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `nft_state_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** The events and their touches, and, when `commit`, the `ledgers` row of every ledger of them (the commit marker). */
  async function insertEvents(ch: ClickHouseService, rows: NftEventsRow[], commit = true): Promise<void> {
    await ch.insert(Table.NftEvents, rows);
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
    if (commit)
      await commitLedgers(
        ch,
        rows.map((r) => r.ledger_index),
      );
  }

  const commitLedgers = (ch: ClickHouseService, ledgers: number[]): Promise<void> =>
    ch.insert(Table.Ledgers, [...new Set(ledgers)].map(ledgerRow));

  /** Stops the merges of a table of the database of `ch`, so that rows written twice stay twice. */
  async function stopMerges(ch: ClickHouseService, table: Table): Promise<void> {
    const db = await ch.queryOne<{ db: string }>('SELECT currentDatabase() AS db');
    await ch.command(`SYSTEM STOP MERGES ${db?.db}.${table}`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  describe('the NFTs of the recorded XRPL ledgers', () => {
    let ch: ClickHouseService;
    let keys: NftKey[];
    let first: { written: number; removed: number; collections: Array<{ issuer: string; taxon_key: number }> };
    let nfts: Map<string, StoredNft>;
    let holdings: StoredHolding[];

    const eventsOf = (id: string): NftEventsRow[] =>
      XRPL_EVENTS.filter((e) => e.nft_id === id).sort(
        (a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.event_index - b.event_index,
      );

    beforeAll(async () => {
      ch = await fresh();
      // the old rows of a rebuild stay in sight, so that their number can be counted
      await stopMerges(ch, Table.Nfts);
      await stopMerges(ch, Table.AccountNfts);
      await new LedgerWriter(ch, xrplCtx).write(XRPL_LEDGERS);
      keys = (await nftsChangedSince(ch, 0, 10_000)).nfts;
      first = await rebuildNfts(ch, keys);
      nfts = new Map((await latestNfts(ch)).map((n) => [n.nft_id, n]));
      holdings = await latestHoldings(ch);
    });

    /** The oracle: the owner and the counts of an NFT, read from its events the plain way. */
    function expected(id: string) {
      const events = eventsOf(id);
      const ownership = events.filter((e) => ['mint', 'sale', 'transfer', 'burn'].includes(e.event));
      const last = ownership[ownership.length - 1];
      const sales = events.filter((e) => e.event === 'sale');
      const mints = events.filter((e) => e.event === 'mint');
      const newestMint = mints[mints.length - 1];
      const uris = events.filter((e) => e.event === 'mint' || e.event === 'modify');
      const owners: string[] = [];
      for (const e of ownership) {
        for (const account of [e.from_account, e.to_account])
          if (account !== '' && !owners.includes(account)) owners.push(account);
      }
      return {
        owner: last === undefined || last.event === 'burn' ? '' : last.to_account,
        burned: last?.event === 'burn' ? 1 : 0,
        sale_count: sales.length,
        last_sale_ledger: sales.length > 0 ? sales[sales.length - 1].ledger_index : null,
        minted_ledger: newestMint ? newestMint.ledger_index : null,
        uri: uris.length > 0 ? uris[uris.length - 1].uri : '',
        first_ledger: events[0].ledger_index,
        last_ledger: events[events.length - 1].ledger_index,
        owners,
      };
    }

    it('writes one row per NFT with an event and none for anything else, in two tables', async () => {
      const ids = [...new Set(XRPL_EVENTS.map((e) => e.nft_id))];
      expect(ids.length).toBeGreaterThan(200);
      expect([...nfts.keys()].sort()).toEqual([...ids].sort());
      expect(first.written).toBe(ids.length);
      expect(first.removed).toBe(0);
      expect(await ch.query(`SELECT count() AS n FROM ${Table.Nfts}`)).toEqual([{ n: ids.length }]);
      // every NFT's holdings: one row per owner it ever had
      const owned = ids.reduce((sum, id) => sum + expected(id).owners.length, 0);
      expect(await ch.query(`SELECT count() AS n FROM ${Table.AccountNfts}`)).toEqual([{ n: owned }]);
    });

    it('every NFT equals the oracle that reads its events', () => {
      for (const [id, row] of nfts) {
        const { owners: _owners, ...want } = expected(id);
        expect([id, row]).toEqual([id, expect.objectContaining(want)]);
      }
    });

    it('every account holds exactly the NFTs whose owner it is', () => {
      const held = holdings.filter((h) => h.held === 1);
      expect(held.map((h) => [h.owner, h.nft_id]).sort()).toEqual(
        [...nfts.values()]
          .filter((n) => n.owner !== '')
          .map((n) => [n.owner, n.nft_id])
          .sort(),
      );
      // and no NFT is held twice
      expect(new Set(held.map((h) => h.nft_id)).size).toBe(held.length);
      // the key columns of a holding are those of the NFT
      for (const h of holdings) {
        const nft = nfts.get(h.nft_id) as StoredNft;
        expect([h.issuer, h.taxon_key, h.serial]).toEqual([nft.issuer, nft.taxon_key, nft.serial]);
      }
    });

    it('moves a holding from seller to buyer', () => {
      const rows = holdings.filter((h) => h.nft_id === SOLD);
      // in the order of the key: the seller's address sorts before the buyer's
      expect(rows.map((h) => [h.owner, h.held])).toEqual([
        [SELLER, 0],
        [BUYER, 1],
      ]);
      const events = eventsOf(SOLD);
      const sold = events.find((e) => e.event === 'sale') as NftEventsRow;
      expect(nfts.get(SOLD)).toMatchObject({
        owner: BUYER,
        owner_ledger: 107874617,
        owner_tx: sold.tx_hash,
        sale_count: 1,
        last_sale_ledger: 107874617,
        last_sale_tx: sold.tx_hash,
        last_sale_amount: '10',
        last_sale_currency: 'XRP',
        last_sale_amount_issuer: '',
        burned: 0,
        minted_ledger: null,
        first_ledger: 107874617,
        last_ledger: 107874617,
        issuer: sold.issuer,
        taxon_key: sold.taxon_key,
        serial: sold.serial,
        kind: 'nftoken',
      });
    });

    it('a burn leaves no holding and marks the NFT burned', () => {
      const burnEvent = eventsOf(BURNED).find((e) => e.event === 'burn') as NftEventsRow;
      expect(nfts.get(BURNED)).toMatchObject({
        owner: '',
        owner_ledger: null,
        owner_tx: '',
        burned: 1,
        burned_ledger: 107879890,
        burned_tx: burnEvent.tx_hash,
        burned_by: BURNER,
        minted_ledger: null,
        sale_count: 0,
      });
      const rows = holdings.filter((h) => h.nft_id === BURNED);
      expect(rows.map((h) => [h.owner, h.held])).toEqual([[BURNER, 0]]);
    });

    it('returns the collections of what it wrote, each once, in key order', () => {
      const wanted = [...new Map([...nfts.values()].map((n) => [`${n.issuer}/${n.taxon_key}`, n])).values()]
        .map(({ issuer, taxon_key }) => ({ issuer, taxon_key }))
        .sort((a, b) => (a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : 0) || a.taxon_key - b.taxon_key);
      expect(wanted.length).toBeGreaterThan(5);
      expect(first.collections).toEqual(wanted);
    });

    it('leaves nothing stale: the watermark is the head and nothing changed', async () => {
      const head = XRPL_LEDGERS[XRPL_LEDGERS.length - 1].header.ledger_index;
      expect(await nftStateWatermark(ch)).toBe(head);
      expect(await nftsChangedSince(ch, 0, 10_000)).toEqual({ nfts: [], upTo: head });
    });

    it('is idempotent: a second rebuild leaves the same newest rows', async () => {
      const before = { nfts: await latestNfts(ch), holdings: await latestHoldings(ch) };
      const again = await rebuildNfts(ch, keys);
      expect(again).toEqual(first);
      const after = { nfts: await latestNfts(ch), holdings: await latestHoldings(ch) };
      expect(withoutVersion(after.nfts)).toEqual(withoutVersion(before.nfts));
      expect(withoutVersion(after.holdings)).toEqual(withoutVersion(before.holdings));
      // the new rows are newer, row by row
      const was = new Map(before.nfts.map((n) => [n.nft_id, n.version]));
      for (const n of after.nfts) expect(n.version).toBeGreaterThan(was.get(n.nft_id) as number);
      // the old rows are still there until a merge: one row more per NFT
      expect(await ch.query(`SELECT count() AS n FROM ${Table.Nfts}`)).toEqual([{ n: 2 * before.nfts.length }]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the URITokens of the recorded Xahau ledgers', () => {
    let ch: ClickHouseService;
    let nfts: Map<string, StoredNft>;
    let holdings: StoredHolding[];

    beforeAll(async () => {
      ch = await fresh();
      await new LedgerWriter(ch, xahauCtx).write(XAHAU_LEDGERS);
      await rebuildNfts(ch, (await nftsChangedSince(ch, 0, 10_000)).nfts);
      nfts = new Map((await latestNfts(ch)).map((n) => [n.nft_id, n]));
      holdings = await latestHoldings(ch);
    });

    it('a token burned and minted again has its owner again, and the first life is kept', () => {
      const mintEvent = XAHAU_EVENTS.find((e) => e.nft_id === REMINTED && e.event === 'mint') as NftEventsRow;
      expect(nfts.get(REMINTED)).toMatchObject({
        kind: 'uritoken',
        taxon: null,
        taxon_key: 0,
        serial: 0,
        owner: REMINTER,
        owner_ledger: 26763629,
        owner_tx: mintEvent.tx_hash,
        burned: 0,
        burned_ledger: null,
        minted_ledger: 26763629,
        minted_by: REMINTER,
        minted_to: REMINTER,
        uri: mintEvent.uri,
        first_ledger: 26763618,
        last_ledger: 26763629,
      });
      expect(mintEvent.uri.startsWith('5A585A79')).toBe(true);
      expect(holdings.filter((h) => h.nft_id === REMINTED).map((h) => [h.owner, h.held])).toEqual([[REMINTER, 1]]);
    });

    it('a token sold for an issued currency has the price of the sale', () => {
      const sold = XAHAU_EVENTS.find((e) => e.nft_id === SOLD_URITOKEN && e.event === 'sale') as NftEventsRow;
      expect(sold.currency).toBe('EVR');
      expect(nfts.get(SOLD_URITOKEN)).toMatchObject({
        owner: sold.to_account,
        sale_count: 1,
        last_sale_ledger: sold.ledger_index,
        last_sale_amount: '0.0011',
        last_sale_currency: 'EVR',
        last_sale_amount_issuer: sold.amount_issuer,
      });
      expect(
        holdings
          .filter((h) => h.nft_id === SOLD_URITOKEN)
          .map((h) => [h.owner, h.held])
          .sort(),
      ).toEqual(
        [
          [sold.from_account, 0],
          [sold.to_account, 1],
        ].sort(),
      );
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('events made by hand', () => {
    it('mint, sale, burn: the NFT is burned, its owner is gone, and every account that had it holds it no more', async () => {
      const ch = await fresh();
      const id = idOf(1);
      await insertEvents(ch, [
        mint(id, 100, ALICE),
        sale(id, 110, ALICE, BOB),
        burn(id, 120, BOB, { account: ISSUER }),
      ]);
      expect(await rebuildNfts(ch, [keyOf(id)])).toEqual({
        written: 1,
        removed: 0,
        collections: [{ issuer: ISSUER, taxon_key: 7 }],
      });
      expect(await latestNfts(ch)).toMatchObject([
        {
          nft_id: id,
          owner: '',
          burned: 1,
          burned_ledger: 120,
          burned_tx: 'synthetic-120-0',
          burned_by: ISSUER,
          minted_ledger: 100,
          minted_by: ISSUER,
          minted_to: ALICE,
          sale_count: 1,
          first_ledger: 100,
          last_ledger: 120,
        },
      ]);
      expect((await latestHoldings(ch)).map((h) => [h.owner, h.held])).toEqual([
        [ALICE, 0],
        [BOB, 0],
      ]);
    });

    it('a re-mint after a burn gives the NFT an owner again', async () => {
      const ch = await fresh();
      const id = idOf(2);
      await insertEvents(ch, [mint(id, 100, ALICE), burn(id, 110, ALICE), mint(id, 120, BOB, { uri: 'BBBB' })]);
      await rebuildNfts(ch, [keyOf(id)]);
      expect(await latestNfts(ch)).toMatchObject([
        { owner: BOB, burned: 0, burned_ledger: null, burned_tx: '', minted_ledger: 120, minted_to: BOB, uri: 'BBBB' },
      ]);
      expect((await latestHoldings(ch)).map((h) => [h.owner, h.held])).toEqual([
        [ALICE, 0],
        [BOB, 1],
      ]);
    });

    it('removes an NFT whose events are gone, and its holdings', async () => {
      const ch = await fresh();
      const [gone, kept] = [idOf(3), idOf(4)];
      await insertEvents(ch, [
        mint(gone, 100, ALICE),
        sale(gone, 110, ALICE, BOB),
        mint(kept, 100, CAROL, { tx_index: 1 }),
      ]);
      await rebuildNfts(ch, [keyOf(gone), keyOf(kept)]);
      expect(
        (await latestHoldings(ch))
          .filter((h) => h.held === 1)
          .map((h) => [h.owner, h.nft_id])
          .sort(),
      ).toEqual([
        [BOB, gone],
        [CAROL, kept],
      ]);

      // a re-ingest dropped its events (and the touches the ledger writer deletes with them)
      await ch.command(
        `DELETE FROM ${Table.NftEvents} WHERE nft_id = {id:String}`,
        { id: gone },
        { settings: SYNC_DELETE },
      );
      await ch.command(
        `DELETE FROM ${Table.NftTouches} WHERE nft_id = {id:String}`,
        { id: gone },
        { settings: SYNC_DELETE },
      );
      expect(await rebuildNfts(ch, [keyOf(gone)])).toEqual({
        written: 0,
        removed: 1,
        collections: [{ issuer: ISSUER, taxon_key: 7 }],
      });

      expect((await latestNfts(ch)).map((n) => n.nft_id)).toEqual([kept]);
      expect(await ch.query(`SELECT count() AS n FROM ${Table.Nfts} WHERE nft_id = {id:String}`, { id: gone })).toEqual(
        [{ n: 0 }],
      );
      const holdings = (await latestHoldings(ch)).filter((h) => h.nft_id === gone);
      expect(holdings.map((h) => [h.owner, h.held])).toEqual([
        [ALICE, 0],
        [BOB, 0],
      ]);
      // the other NFT is as it was
      expect((await latestHoldings(ch)).filter((h) => h.nft_id === kept).map((h) => [h.owner, h.held])).toEqual([
        [CAROL, 1],
      ]);
      // and removing it again is nothing to do: nothing of it is stored but holdings that say it is not held
      const rows = await ch.query(`SELECT count() AS n FROM ${Table.AccountNfts}`);
      expect(await rebuildNfts(ch, [keyOf(gone)])).toEqual({ written: 0, removed: 0, collections: [] });
      expect(await ch.query(`SELECT count() AS n FROM ${Table.AccountNfts}`)).toEqual(rows);
    });

    it('an NFT with no event and nothing stored is nothing to do', async () => {
      const ch = await fresh();
      await commitLedgers(ch, [100]);
      expect(await rebuildNfts(ch, [keyOf(idOf(5))])).toEqual({ written: 0, removed: 0, collections: [] });
      expect(await rebuildNfts(ch, [])).toEqual({ written: 0, removed: 0, collections: [] });
      expect(await ch.query(`SELECT count() AS n FROM ${Table.Nfts}`)).toEqual([{ n: 0 }]);
      expect(await ch.query(`SELECT count() AS n FROM ${Table.AccountNfts}`)).toEqual([{ n: 0 }]);
    });

    it('rebuilding 500 NFTs of an owner of 120,000 writes 500 nfts and 500 account_nfts rows', async () => {
      const ch = await fresh();
      const owner = 'rSyntheticWhale';
      const HELD = 120_000;
      // 120,000 mints to one owner, a hundred transactions a ledger: written in SQL, not through 120,000 JSON rows
      await ch.command(
        `INSERT INTO ${Table.NftEvents}
           (nft_id, ledger_index, tx_index, event_index, tx_hash, close_time, kind, event, issuer, taxon, taxon_key, serial, account, to_account)
         SELECT leftPad(hex(number), 64, '0'), toUInt32(1000 + intDiv(number, 100)), toUInt32(number % 100), 0,
                concat('synthetic-', toString(number)), toDateTime({t0:UInt32}), 'nftoken', 'mint', {issuer:String}, 7, 7,
                toUInt32(number), {owner:String}, {owner:String}
           FROM numbers({n:UInt32})`,
        { t0: T0, issuer: ISSUER, owner, n: HELD },
      );
      await ch.command(
        `INSERT INTO ${Table.NftTouches} (ledger_index, tx_index, nft_id, issuer, taxon_key, serial)
         SELECT toUInt32(1000 + intDiv(number, 100)), toUInt32(number % 100), leftPad(hex(number), 64, '0'), {issuer:String}, 7, toUInt32(number)
           FROM numbers({n:UInt32})`,
        { issuer: ISSUER, n: HELD },
      );
      await commitLedgers(
        ch,
        Array.from({ length: HELD / 100 }, (_, i) => 1000 + i),
      );
      expect(await ch.query(`SELECT count() AS n FROM ${Table.NftEvents}`)).toEqual([{ n: HELD }]);

      const batch = Array.from({ length: NFT_STATE_BATCH }, (_, i) => keyOf(idOf(i * 200)));
      expect(batch).toHaveLength(500);
      expect(await rebuildNfts(ch, batch)).toEqual({
        written: 500,
        removed: 0,
        collections: [{ issuer: ISSUER, taxon_key: 7 }],
      });
      expect(await ch.query(`SELECT count() AS n FROM ${Table.Nfts}`)).toEqual([{ n: 500 }]);
      expect(await ch.query(`SELECT count() AS n FROM ${Table.AccountNfts}`)).toEqual([{ n: 500 }]);
      const stored = await latestHoldings(ch);
      expect(stored.every((h) => h.owner === owner && h.held === 1)).toBe(true);
      // one version for the batch
      expect(new Set(stored.map((h) => h.version)).size).toBe(1);
    });

    it('a batch of more than NFT_STATE_BATCH is written a batch at a time, each under one version', async () => {
      const ch = await fresh();
      const ids = Array.from({ length: NFT_STATE_BATCH + 3 }, (_, i) => idOf(i + 10));
      await insertEvents(
        ch,
        ids.map((id, i) => mint(id, 100, ALICE, { tx_index: i })),
      );
      const done = await rebuildNfts(
        ch,
        ids.map((id) => keyOf(id)),
      );
      expect(done).toMatchObject({ written: NFT_STATE_BATCH + 3, removed: 0 });
      // in the order of the keys: the first batch of 500, then the three left
      const rows = await latestNfts(ch);
      expect(rows).toHaveLength(NFT_STATE_BATCH + 3);
      expect(new Set(rows.slice(0, NFT_STATE_BATCH).map((n) => n.version)).size).toBe(1);
      expect(new Set(rows.slice(NFT_STATE_BATCH).map((n) => n.version)).size).toBe(1);
    });

    it('the version is above the newest of the rows it replaces, and above the clock', async () => {
      const ch = await fresh();
      const id = idOf(6);
      await insertEvents(ch, [mint(id, 100, ALICE)]);
      await rebuildNfts(ch, [keyOf(id)]);
      const [row] = await latestNfts(ch);
      expect(row.version).toBeGreaterThan(1_700_000_000_000);

      // a row whose version is far ahead of the clock (the clock stepped back): the next write is one past it
      const ahead = row.version + 3_600_000;
      await ch.insert(Table.Nfts, [{ ...row, version: ahead, owner: BOB }]);
      await ch.insert(Table.AccountNfts, [
        { owner: BOB, issuer: ISSUER, taxon_key: 7, serial: row.serial, nft_id: id, held: 1, version: ahead },
      ]);
      await rebuildNfts(ch, [keyOf(id)]);
      const [after] = await latestNfts(ch);
      expect(after.version).toBe(ahead + 1);
      expect(after.owner).toBe(ALICE);
      // the previous owner of that row has a row of the new version that says it holds the NFT no more
      expect((await latestHoldings(ch)).map((h) => [h.owner, h.held, h.version]).sort()).toEqual([
        [ALICE, 1, ahead + 1],
        [BOB, 0, ahead + 1],
      ]);
    });

    it('the owner of the row it replaces, which the events no longer name, holds the NFT no more', async () => {
      const ch = await fresh();
      const id = idOf(7);
      await insertEvents(ch, [mint(id, 100, ALICE), sale(id, 110, ALICE, BOB)]);
      await rebuildNfts(ch, [keyOf(id)]);
      expect((await latestNfts(ch))[0].owner).toBe(BOB);
      // a re-ingest that no longer finds the sale
      await ch.command(
        `DELETE FROM ${Table.NftEvents} WHERE nft_id = {id:String} AND event = 'sale'`,
        { id },
        { settings: SYNC_DELETE },
      );
      await rebuildNfts(ch, [keyOf(id)]);
      expect((await latestNfts(ch))[0]).toMatchObject({ owner: ALICE, sale_count: 0, last_ledger: 100 });
      expect((await latestHoldings(ch)).map((h) => [h.owner, h.held])).toEqual([
        [ALICE, 1],
        [BOB, 0],
      ]);
    });

    it('reads an event once even when its row was written twice', async () => {
      const ch = await fresh();
      const id = idOf(8);
      await stopMerges(ch, Table.NftEvents);
      const rows = [mint(id, 100, ALICE), sale(id, 110, ALICE, BOB)];
      await insertEvents(ch, rows);
      // the sale again, in a block of its own (an identical block would be dropped on insert)
      await ch.insert(Table.NftEvents, [rows[1]]);
      expect(await ch.query(`SELECT count() AS n FROM ${Table.NftEvents}`)).toEqual([{ n: 3 }]);
      await rebuildNfts(ch, [keyOf(id)]);
      expect(await latestNfts(ch)).toMatchObject([{ owner: BOB, sale_count: 1 }]);
    });

    it('reads nothing above the committed head', async () => {
      const ch = await fresh();
      const [seen, partly, unseen] = [idOf(9), idOf(10), idOf(11)];
      // ledger 200 is being written: its events are there, its ledgers row is not
      await insertEvents(ch, [mint(seen, 100, ALICE), mint(partly, 100, ALICE, { tx_index: 1 })]);
      await insertEvents(ch, [sale(partly, 200, ALICE, BOB), mint(unseen, 200, CAROL, { tx_index: 1 })], false);
      const both = [keyOf(seen), keyOf(partly)].sort(byNftId);
      // what the scans offer stops at the head
      expect(await nftsChangedSince(ch, 0, 10)).toEqual({ nfts: both, upTo: 100 });
      expect(await nftsInLedgers(ch, 1, 1_000)).toEqual(both);
      expect(await nftStateWatermark(ch)).toBe(99);

      expect(await rebuildNfts(ch, [keyOf(seen), keyOf(partly), keyOf(unseen)])).toEqual({
        written: 2,
        removed: 0,
        collections: [{ issuer: ISSUER, taxon_key: 7 }],
      });
      const rows = await latestNfts(ch);
      expect(rows.map((n) => [n.nft_id, n.owner, n.sale_count, n.last_ledger]).sort()).toEqual(
        [
          [seen, ALICE, 0, 100],
          [partly, ALICE, 0, 100],
        ].sort(),
      );
      expect((await latestHoldings(ch)).map((h) => h.nft_id).sort()).toEqual([partly, seen].sort());
      expect(await nftStateWatermark(ch)).toBe(100);

      // once the ledger is committed it is read
      await commitLedgers(ch, [200]);
      await rebuildNfts(ch, [keyOf(partly), keyOf(unseen)]);
      expect((await latestNfts(ch)).map((n) => [n.nft_id, n.owner, n.sale_count, n.last_ledger]).sort()).toEqual(
        [
          [seen, ALICE, 0, 100],
          [partly, BOB, 1, 200],
          [unseen, CAROL, 0, 200],
        ].sort(),
      );
    });

    it('writes nothing while no ledger is committed', async () => {
      const ch = await fresh();
      const id = idOf(12);
      await insertEvents(ch, [mint(id, 100, ALICE)], false);
      expect(await rebuildNfts(ch, [keyOf(id)])).toEqual({ written: 0, removed: 0, collections: [] });
      expect(await ch.query(`SELECT count() AS n FROM ${Table.Nfts}`)).toEqual([{ n: 0 }]);
      expect(await nftStateWatermark(ch)).toBe(0);
    });

    describe('abort', () => {
      it('writes nothing for a signal that was aborted before it started', async () => {
        const ch = await fresh();
        const id = idOf(13);
        await insertEvents(ch, [mint(id, 100, ALICE)]);
        const controller = new AbortController();
        controller.abort();
        const insert = jest.spyOn(ch, 'insert');
        await expect(rebuildNfts(ch, [keyOf(id)], { signal: controller.signal })).rejects.toThrow(NftRebuildAborted);
        expect(insert).not.toHaveBeenCalled();
        expect(await ch.query(`SELECT count() AS n FROM ${Table.Nfts}`)).toEqual([{ n: 0 }]);
      });

      it('writes nothing for a signal that is aborted while it reads', async () => {
        const ch = await fresh();
        const [one, other] = [idOf(14), idOf(15)];
        await insertEvents(ch, [mint(one, 100, ALICE), mint(other, 100, BOB, { tx_index: 1 })]);
        const controller = new AbortController();
        const query = ch.query.bind(ch);
        // the shutdown begins as the events are read
        jest.spyOn(ch, 'query').mockImplementation((async (sql: string, params?: Record<string, unknown>) => {
          const rows = await query(sql, params);
          if (sql.includes(`FROM ${Table.NftEvents}`)) controller.abort();
          return rows;
        }) as unknown as typeof ch.query);
        const insert = jest.spyOn(ch, 'insert');
        const command = jest.spyOn(ch, 'command');
        await expect(rebuildNfts(ch, [keyOf(one), keyOf(other)], { signal: controller.signal })).rejects.toThrow(
          NftRebuildAborted,
        );
        expect(insert).not.toHaveBeenCalled();
        expect(command).not.toHaveBeenCalled();
        jest.restoreAllMocks();
        expect(await ch.query(`SELECT count() AS n FROM ${Table.Nfts}`)).toEqual([{ n: 0 }]);
        expect(await ch.query(`SELECT count() AS n FROM ${Table.AccountNfts}`)).toEqual([{ n: 0 }]);
      });

      it('is an Error that says what happened', () => {
        const error = new NftRebuildAborted();
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('NftRebuildAborted');
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('what to rebuild', () => {
    it('nftsChangedSince returns every stale NFT and the head when there are no more than limit', async () => {
      const ch = await fresh();
      const [a, b, c] = [idOf(20), idOf(21), idOf(22)];
      await insertEvents(ch, [mint(a, 100, ALICE), mint(b, 200, ALICE), mint(c, 300, ALICE)]);
      await commitLedgers(ch, [400]);

      const all = await nftsChangedSince(ch, 0, 3);
      expect(all.nfts.map((k) => k.nft_id)).toEqual([a, b, c]);
      expect(all.nfts[0]).toEqual(keyOf(a));
      expect(all.upTo).toBe(400);
      // only the touches after the cursor
      expect((await nftsChangedSince(ch, 150, 10)).nfts.map((k) => k.nft_id)).toEqual([b, c]);
      // nothing after the head, and nothing while the head is not past the cursor
      expect(await nftsChangedSince(ch, 400, 10)).toEqual({ nfts: [], upTo: 400 });
      expect(await nftsChangedSince(ch, 500, 10)).toEqual({ nfts: [], upTo: 500 });
      // a rebuilt NFT is not stale
      await rebuildNfts(ch, [keyOf(b)]);
      expect((await nftsChangedSince(ch, 0, 10)).nfts.map((k) => k.nft_id)).toEqual([a, c]);
      // a touch above what its row has seen is: the NFT is back, from that touch on
      await insertEvents(ch, [sale(b, 350, ALICE, BOB)]);
      await commitLedgers(ch, [450]);
      expect((await nftsChangedSince(ch, 0, 10)).nfts.map((k) => k.nft_id)).toEqual([a, c, b]);
      expect(await nftsChangedSince(ch, 360, 10)).toEqual({ nfts: [], upTo: 450 });
    });

    it('nftsChangedSince cuts before the first NFT left out, and takes all of a first ledger with more than limit', async () => {
      const ch = await fresh();
      const [a, b, c, d] = [idOf(30), idOf(31), idOf(32), idOf(33)];
      await insertEvents(ch, [
        mint(a, 100, ALICE),
        mint(b, 100, ALICE, { tx_index: 1 }),
        mint(c, 200, ALICE),
        mint(d, 300, ALICE),
      ]);
      const ids = async (ledger: number, limit: number) => {
        const changed = await nftsChangedSince(ch, ledger, limit);
        return { nfts: changed.nfts.map((k) => k.nft_id), upTo: changed.upTo };
      };
      // four stale NFTs and a limit of 3: the first left out is d (300): a, b and c, complete up to 299
      expect(await ids(0, 3)).toEqual({ nfts: [a, b, c], upTo: 299 });
      // a limit of 2: the first left out is c (200)
      expect(await ids(0, 2)).toEqual({ nfts: [a, b], upTo: 199 });
      // the cursor goes on from there: c and d, and the head
      expect(await ids(199, 2)).toEqual({ nfts: [c, d], upTo: 300 });
      // a limit of 1: the first left out is b, whose first touch is the one of a: all of ledger 100, more than the limit
      expect(await ids(0, 1)).toEqual({ nfts: [a, b], upTo: 100 });
      // and from there the next ones
      expect(await ids(100, 1)).toEqual({ nfts: [c], upTo: 299 });
      // a limit of 0 is a limit of 1
      expect(await ids(0, 0)).toEqual({ nfts: [a, b], upTo: 100 });

      // a rebuilt NFT of that ledger is not in it: five at ledger 500, one of them rebuilt
      const crowd = [40, 41, 42, 43, 44].map(idOf);
      await insertEvents(
        ch,
        crowd.map((id, i) => mint(id, 500, ALICE, { tx_index: i })),
      );
      await rebuildNfts(ch, [keyOf(crowd[2])]);
      expect(await ids(400, 2)).toEqual({ nfts: [crowd[0], crowd[1], crowd[3], crowd[4]], upTo: 500 });
    });

    it('nftStateWatermark is the ledger before the oldest touch its NFT has not seen', async () => {
      const ch = await fresh();
      // no ledger: 0
      expect(await nftStateWatermark(ch)).toBe(0);
      const [a, b, c] = [idOf(50), idOf(51), idOf(52)];
      await insertEvents(ch, [mint(a, 100, ALICE), mint(b, 200, ALICE), mint(c, 300, ALICE)]);
      // nothing rebuilt: the ledger before the oldest touch
      expect(await nftStateWatermark(ch)).toBe(99);
      await rebuildNfts(ch, [keyOf(a)]);
      expect(await nftStateWatermark(ch)).toBe(199);
      // the rebuilt NFT's own newest event is not stale, whatever the head is
      await commitLedgers(ch, [350]);
      await rebuildNfts(ch, [keyOf(c)]);
      expect(await nftStateWatermark(ch)).toBe(199);
      await rebuildNfts(ch, [keyOf(b)]);
      expect(await nftStateWatermark(ch)).toBe(350);
      // a new event of an NFT that was rebuilt: from its touch on
      await insertEvents(ch, [sale(a, 340, ALICE, BOB)]);
      expect(await nftStateWatermark(ch)).toBe(339);
      // a touch above the head says nothing: the ledger is not committed
      await rebuildNfts(ch, [keyOf(a)]);
      await insertEvents(ch, [sale(a, 400, BOB, CAROL)], false);
      expect(await nftStateWatermark(ch)).toBe(350);
    });

    it('nftsInLedgers finds the NFTs touched in the range and those whose rows last saw it', async () => {
      const ch = await fresh();
      const [touched, later, outside, dropped, old, moved] = [60, 61, 62, 63, 64, 65].map(idOf);
      await insertEvents(ch, [
        mint(touched, 100, ALICE),
        sale(touched, 150, ALICE, BOB),
        mint(later, 120, ALICE, { tx_index: 1 }),
        mint(outside, 500, ALICE),
        mint(dropped, 100, ALICE, { tx_index: 2 }),
        mint(old, 50, ALICE),
        sale(old, 500, ALICE, BOB, { tx_index: 1 }),
        mint(moved, 100, ALICE, { tx_index: 3 }),
      ]);
      await rebuildNfts(
        ch,
        [touched, later, outside, dropped, old, moved].map((id) => keyOf(id)),
      );
      // a re-ingest dropped the events of `dropped`, and moved those of `moved` from ledger 100 to ledger 700
      for (const id of [dropped, moved]) {
        await ch.command(
          `DELETE FROM ${Table.NftEvents} WHERE nft_id = {id:String}`,
          { id },
          { settings: SYNC_DELETE },
        );
        await ch.command(
          `DELETE FROM ${Table.NftTouches} WHERE nft_id = {id:String}`,
          { id },
          { settings: SYNC_DELETE },
        );
      }
      await insertEvents(ch, [mint(moved, 700, ALICE, { tx_index: 3 })]);
      await rebuildNfts(ch, [keyOf(moved)]);

      const found = async (from: number, to: number) => (await nftsInLedgers(ch, from, to)).map((k) => k.nft_id);
      // `dropped`'s row last saw ledger 100 though nothing is left there to touch it; `old`'s row first saw 50, last 500
      expect(await found(100, 120)).toEqual([touched, later, dropped].sort());
      expect(await found(50, 50)).toEqual([old]);
      expect(await found(500, 500)).toEqual([outside, old].sort());
      // `moved`: its newest row is the one of ledger 700; the older row that saw ledger 100 does not count
      expect(await found(700, 700)).toEqual([moved]);
      expect(await found(101, 119)).toEqual([]);
      // the range is both ends inclusive, and the keys come in the order of the table
      expect(await found(150, 150)).toEqual([touched]);
      expect(await nftsInLedgers(ch, 120, 120)).toEqual([keyOf(later)]);
      expect(await found(1, 1_000_000)).toEqual([touched, later, outside, dropped, old, moved].sort());
      // nothing for a range that ends before it starts
      expect(await nftsInLedgers(ch, 200, 100)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the nft_dirty queue', () => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const mark = (ch: ClickHouseService, from: number, to: number, created: number) =>
      ch.insert(Table.NftDirty, [{ from_ledger: from, to_ledger: to, created_at: created }]);

    it('marks ranges, gives the oldest first and counts their ledgers', async () => {
      const ch = await fresh();
      expect(await oldestNftDirty(ch)).toBeUndefined();
      expect(await nftDirtyLedgers(ch)).toBe(0);
      await markNftDirty(ch, 300, 399);
      await sleep(5);
      await markNftDirty(ch, 100, 199);
      const oldest = (await oldestNftDirty(ch)) as NftDirtyRange;
      expect(oldest).toMatchObject({ from: 300, to: 399 });
      expect(oldest.created).toBeGreaterThan(1_700_000_000_000);
      expect(await nftDirtyLedgers(ch)).toBe(200);
      // a range of one ledger, and an empty one that marks nothing
      await markNftDirty(ch, 7, 7);
      await markNftDirty(ch, 9, 8);
      expect(await nftDirtyLedgers(ch)).toBe(201);
    });

    it('a range marked twice is one, marked at its newest mark', async () => {
      const ch = await fresh();
      await stopMerges(ch, Table.NftDirty);
      await mark(ch, 100, 199, 1_700_000_000.123);
      await mark(ch, 100, 199, 1_700_000_005.5);
      expect(await ch.query(`SELECT count() AS n FROM ${Table.NftDirty}`)).toEqual([{ n: 2 }]);
      expect(await nftDirtyLedgers(ch)).toBe(100);
      expect(await oldestNftDirty(ch)).toEqual({ from: 100, to: 199, created: 1_700_000_005_500 });
    });

    it('the oldest mark goes first, ties by range', async () => {
      const ch = await fresh();
      await mark(ch, 500, 599, 1_700_000_002);
      await mark(ch, 300, 399, 1_700_000_001);
      await mark(ch, 200, 299, 1_700_000_001);
      expect(await oldestNftDirty(ch)).toEqual({ from: 200, to: 299, created: 1_700_000_001_000 });
    });

    it('narrowNftDirty keeps the progress, deleteNftDirty keeps a mark made after the read', async () => {
      const ch = await fresh();
      await mark(ch, 100, 199, 1_700_000_000.123);
      await mark(ch, 300, 399, 1_700_000_100);
      const range = (await oldestNftDirty(ch)) as NftDirtyRange;
      expect(range).toEqual({ from: 100, to: 199, created: 1_700_000_000_123 });

      // progress to 150: [150, 199], marked as before, so it is still the first of the queue
      await narrowNftDirty(ch, range, 150);
      const narrowed = (await oldestNftDirty(ch)) as NftDirtyRange;
      expect(narrowed).toEqual({ from: 150, to: 199, created: 1_700_000_000_123 });
      expect(await ch.query(`SELECT count() AS n FROM ${Table.NftDirty}`)).toEqual([{ n: 2 }]);
      expect(await nftDirtyLedgers(ch)).toBe(50 + 100);

      // no progress, or progress before the start: nothing changes
      await narrowNftDirty(ch, narrowed, 150);
      await narrowNftDirty(ch, narrowed, 120);
      expect(await oldestNftDirty(ch)).toEqual(narrowed);

      // the ingest marks [150, 199] again while the job works on it: the delete of what was read keeps that mark
      await mark(ch, 150, 199, 1_700_000_050);
      await deleteNftDirty(ch, narrowed);
      expect(await oldestNftDirty(ch)).toEqual({ from: 150, to: 199, created: 1_700_000_050_000 });
      expect(await nftDirtyLedgers(ch)).toBe(150);

      // a mark that was read is deleted with every older one of its key, and nothing of another key
      await deleteNftDirty(ch, (await oldestNftDirty(ch)) as NftDirtyRange);
      expect(await oldestNftDirty(ch)).toEqual({ from: 300, to: 399, created: 1_700_000_100_000 });
      expect(await nftDirtyLedgers(ch)).toBe(100);
    });

    it('progress past the end of a range finishes it', async () => {
      const ch = await fresh();
      await mark(ch, 100, 199, 1_700_000_000);
      await mark(ch, 300, 399, 1_700_000_001);
      await narrowNftDirty(ch, (await oldestNftDirty(ch)) as NftDirtyRange, 200);
      expect(await oldestNftDirty(ch)).toEqual({ from: 300, to: 399, created: 1_700_000_001_000 });
      expect(await nftDirtyLedgers(ch)).toBe(100);
    });

    it('a crash between the narrowed row and the delete leaves both, which is worked on twice and nothing more', async () => {
      const ch = await fresh();
      await mark(ch, 100, 199, 1_700_000_000);
      const range = (await oldestNftDirty(ch)) as NftDirtyRange;
      // the narrowed row alone: what a crash after the insert leaves, next to the old row
      await mark(ch, 150, 199, 1_700_000_000);
      expect(await nftDirtyLedgers(ch)).toBe(150);
      expect(await oldestNftDirty(ch)).toEqual({ from: 100, to: 199, created: 1_700_000_000_000 });
      await deleteNftDirty(ch, range);
      expect(await oldestNftDirty(ch)).toEqual({ from: 150, to: 199, created: 1_700_000_000_000 });
    });
  });
});
