import {
  AccountNftsRow,
  buildLedgerRows,
  ClickHouseService,
  CollectionKey,
  collectionsBehind,
  DailyRates,
  firstCommittedLedger,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  markNftDirty,
  narrowNftDirty,
  NFT_DIRTY_STEP_LEDGERS,
  NFT_LIVE_STEP_LEDGERS,
  NFT_STATE_BATCH,
  NftCollectionHoldersRow,
  NftCollectionsRow,
  nftDirtyLedgers,
  NftEventsRow,
  nftsChangedSince,
  NftsRow,
  parseContextFor,
  PARSER_VERSION,
  RatesService,
  rebuildNfts,
  recomputeCollections,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { join } from 'node:path';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { readDirtyRanges } from '../src/aggregator/agg-dirty';
import {
  AGGREGATOR_NFT_STATE_BUDGET_MS,
  AggregatorService,
  NFT_COLLECTIONS_EVERY_TICKS,
} from '../src/aggregator/aggregator.service';
import { rangeIngest } from '../src/cli/range-ingest';

/**
 * The `nft_state` and `nft_collections` jobs of the `AggregatorService` against a real ClickHouse: the 11 whole mainnet ledgers of the NFT fixtures
 * (`fixtures/xrpl/nft`: mints, offers, sales, a burn, a modify), written by the real `LedgerWriter`, and a world of 120,000 NFTs
 * of one owner made by hand (their transactions are `synthetic-…`). What an NFT holds is checked against an oracle in
 * `packages/shared/test/nft-state-job.e2e-spec.ts`; here it is the job that is on trial: what ticks write, that they stay within
 * their budget, that the cursor is in the tables so that a restart goes on, and the whole path of a `range-ingest --reprocess`
 * through `agg_dirty` and the hook to `nft_dirty` and the dirty sweep.
 */

const SHARED_TEST = join(__dirname, '../../../packages/shared/test');
const ctx = parseContextFor(getNetworkProfile('xrpl'));
const LEDGERS = FixtureLedgerSource.fromDir(join(SHARED_TEST, 'fixtures/xrpl/nft')).list();
const EVENTS: NftEventsRow[] = LEDGERS.flatMap((raw) => buildLedgerRows(raw, ctx).nftEvents);
const NFT_IDS = [...new Set(EVENTS.map((e) => e.nft_id))].sort();
const byCollection = (a: CollectionKey, b: CollectionKey): number =>
  a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : a.taxon_key - b.taxon_key;
/** The collections of the recorded events (an issuer and, on XRPL, a taxon), in key order. */
const COLLECTIONS: CollectionKey[] = [
  ...new Map(
    EVENTS.map(({ issuer, taxon_key }) => [`${issuer}/${taxon_key}`, { issuer, taxon_key } as CollectionKey]),
  ).values(),
].sort(byCollection);
const FIRST_LEDGER = Math.min(...LEDGERS.map((l) => l.header.ledger_index));
const LAST_LEDGER = Math.max(...LEDGERS.map((l) => l.header.ledger_index));
const NEWEST_CLOSE = Math.max(...LEDGERS.map((l) => l.header.close_time));
/** A moment after the ingest: the stats have nothing to do but jump from ledger to ledger. */
const NOW = new Date((NEWEST_CLOSE + 7200) * 1000);

const NOOP = (): void => undefined;
/** Options that keep `range-ingest` quick and the output of the suite clean. */
const FAST = {
  retryBackoffMs: 1,
  quiescenceTimeoutMs: 5_000,
  maxTransientWaitMs: 0,
  logger: { log: NOOP, warn: NOOP, error: NOOP },
};
/** Passed on every lightweight DELETE so that it returns once it has been applied. */
const SYNC_DELETE = { settings: { lightweight_deletes_sync: '2' } } as const;
const NFT_LEDGER_TABLES = [
  Table.NftEvents,
  Table.AccountNftEvents,
  Table.CollectionNftEvents,
  Table.NftSales,
  Table.NftTouches,
];

// Recorded NFTs (see packages/shared/test/fixtures/xrpl/nft/FINDINGS.md): a direct sale of 10 XRP.
const SOLD = '00081388EA968E3C54EE59C8FFBAF0944A3B8AD4797AB032EF22952605AD2A91';
const SELLER = 'rhv9jFwfWfH4Cd1uX4b3ACkdgDKASFz7Dz';
const BUYER = 'rnKd8CYrXwMoGn4R48onJGLShh1PcrFrTx';

// The world made by hand: 120,000 NFTs minted to one owner, 50 to a ledger.
const SYNTHETIC_NFTS = 120_000;
const SYNTHETIC_PER_LEDGER = 50;
const SYNTHETIC_FIRST_LEDGER = 90_000_000;
const SYNTHETIC_LEDGERS = SYNTHETIC_NFTS / SYNTHETIC_PER_LEDGER;
const SYNTHETIC_T0 = 1_700_000_000;
const SYNTHETIC_ISSUER = 'rSyntheticIssuer';
const SYNTHETIC_OWNER = 'rSyntheticOwner';

const KEY = 'issuer, taxon_key, serial, nft_id';

type StoredNft = Omit<NftsRow, 'version'>;
type StoredHolding = Omit<AccountNftsRow, 'version'>;
type StoredCollection = Omit<NftCollectionsRow, 'version'> & { version: number };
type StoredCollectionHolder = Omit<NftCollectionHoldersRow, 'version'>;

/** The fake metrics of the aggregator and of the NFT job: what is set and counted is read from the mocks. */
const fakeMetrics = () => ({
  aggregatorRunsTotal: { inc: jest.fn() },
  aggregatorErrorsTotal: { inc: jest.fn() },
  aggregatorStatsLagSeconds: { set: jest.fn() },
  nftStateLagLedgers: { set: jest.fn() },
  nftDirtyLedgers: { set: jest.fn() },
  nftCollectionsPending: { set: jest.fn() },
});
type FakeMetrics = ReturnType<typeof fakeMetrics>;

/** The values a gauge was set to, in order. */
const valuesOf = (gauge: { set: jest.Mock }): number[] => gauge.set.mock.calls.map(([value]) => value);

describe('AggregatorService NFT jobs (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  const aggregators: AggregatorService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of aggregators) await svc.stop();
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  /** A migrated database of its own, with the NFT ledgers in it when `fixtures` (written by the real `LedgerWriter`). */
  async function fresh(fixtures = true): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_nfts_${++dbCounter}` };
    await runMigrations({ config, log: NOOP });
    const svc = new ClickHouseService(config);
    services.push(svc);
    if (fixtures) await new LedgerWriter(svc, ctx).write(LEDGERS);
    return svc;
  }

  /** An aggregator that has the NFT job and, of the stats, only the walk from ledger to ledger (the stats have their own tests). */
  function aggregator(
    ch: ClickHouseService,
    options: Partial<ConstructorParameters<typeof AggregatorService>[3]> = {},
  ): { svc: AggregatorService; metrics: FakeMetrics; errors: jest.Mock } {
    const metrics = fakeMetrics();
    const errors = jest.fn();
    const rates = new RatesService(ch, 'XRP');
    const svc = new AggregatorService(ch, metrics as never, undefined, {
      logger: { log: NOOP, warn: NOOP, debug: NOOP, error: errors },
      nfts: { rates, dailyRates: new DailyRates(ch, rates) },
      recompute: async () => 0,
      ...options,
    });
    aggregators.push(svc);
    return { svc, metrics, errors };
  }

  /**
   * Ticks until the lag of the live cursor is 0 and no dirty range is left, and says how many it took: the first tick starts the
   * read of the cursor and does not wait for it (a query may take as long as the tick), so the live part begins at the next, and
   * a cursor placed far behind the head leaves the ledgers after it to the dirty ranges.
   */
  async function catchUp(
    { svc, metrics }: { svc: AggregatorService; metrics: FakeMetrics },
    most = 5,
  ): Promise<number> {
    let ticks = 0;
    do {
      await svc.tick(NOW);
      ticks++;
    } while (
      (valuesOf(metrics.nftStateLagLedgers).at(-1) !== 0 || valuesOf(metrics.nftDirtyLedgers).at(-1) !== 0) &&
      ticks < most
    );
    return ticks;
  }

  /** The newest version of each NFT, without its version. */
  async function nftsOf(ch: ClickHouseService): Promise<StoredNft[]> {
    const rows = await ch.query<NftsRow>(`SELECT * FROM ${Table.Nfts} ORDER BY ${KEY}, version DESC LIMIT 1 BY ${KEY}`);
    return rows.map(({ version: _version, ...row }) => row);
  }

  /** The newest version of each (owner, NFT), without its version. */
  async function holdingsOf(ch: ClickHouseService): Promise<StoredHolding[]> {
    const rows = await ch.query<AccountNftsRow>(
      `SELECT * FROM ${Table.AccountNfts} ORDER BY owner, ${KEY}, version DESC LIMIT 1 BY owner, ${KEY}`,
    );
    return rows.map(({ version: _version, ...row }) => row);
  }

  /** The newest version of each collection. */
  async function collectionsOf(ch: ClickHouseService): Promise<StoredCollection[]> {
    const rows = await ch.query<NftCollectionsRow>(
      `SELECT * FROM ${Table.NftCollections} ORDER BY issuer, taxon_key, version DESC LIMIT 1 BY issuer, taxon_key`,
    );
    return rows.map((row) => ({ ...row, version: Number(row.version) }));
  }

  /** The newest version of each (collection, owner), without its version: the holders a reader lists are the ones with `held` above 0. */
  async function collectionHoldersOf(ch: ClickHouseService): Promise<StoredCollectionHolder[]> {
    const rows = await ch.query<NftCollectionHoldersRow>(
      `SELECT * FROM ${Table.NftCollectionHolders}
        ORDER BY issuer, taxon_key, owner, version DESC LIMIT 1 BY issuer, taxon_key, owner`,
    );
    return rows.map(({ version: _version, ...row }) => row);
  }

  const withoutVersion = (rows: StoredCollection[]): Array<Omit<StoredCollection, 'version'>> =>
    rows.map(({ version: _version, ...row }) => row);

  /**
   * Ticks until the NFT state is caught up and the collections job has had its turn after that: it runs at the first tick and
   * every `NFT_COLLECTIONS_EVERY_TICKS` ticks, and the collections of the NFTs rebuilt in between are for its next run.
   */
  async function computeCollections(running: { svc: AggregatorService; metrics: FakeMetrics }): Promise<void> {
    let ticks = await catchUp(running);
    while (ticks <= NFT_COLLECTIONS_EVERY_TICKS) {
      await running.svc.tick(NOW);
      ticks++;
    }
  }

  const count = async (ch: ClickHouseService, table: Table, where = '1'): Promise<number> =>
    Number((await ch.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${table} WHERE ${where}`))?.n);

  /** The ranges of `nft_dirty`, newest mark of each. */
  async function dirtyRanges(ch: ClickHouseService): Promise<Array<[number, number]>> {
    const rows = await ch.query<{ from_ledger: number | string; to_ledger: number | string }>(
      `SELECT from_ledger, to_ledger FROM ${Table.NftDirty} ORDER BY from_ledger, to_ledger`,
    );
    return rows.map((r) => [Number(r.from_ledger), Number(r.to_ledger)]);
  }

  it('builds nfts and account_nfts for every recorded NFT within a few ticks', async () => {
    expect(NFT_IDS.length).toBeGreaterThan(200);
    const ch = await fresh();
    // the same ledgers in a world of their own, in which every NFT is rebuilt by the function the job calls
    const reference = await fresh();
    await rebuildNfts(reference, (await nftsChangedSince(reference, 0, 10_000)).nfts);

    expect(await count(ch, Table.Nfts)).toBe(0);
    const { svc, metrics, errors } = aggregator(ch);
    // the first tick starts the read of the cursor; the lag is not reported until the cursor is placed, and never the whole head
    await catchUp({ svc, metrics });
    expect(valuesOf(metrics.nftStateLagLedgers).at(-1)).toBe(0);
    for (const lag of valuesOf(metrics.nftStateLagLedgers)) expect(lag).toBeLessThan(NFT_LIVE_STEP_LEDGERS);
    expect(errors).not.toHaveBeenCalled();
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
    expect(valuesOf(metrics.nftDirtyLedgers).at(-1)).toBe(0);

    // every NFT has its row, and what the job wrote is what a direct rebuild of the same NFTs writes
    const nfts = await nftsOf(ch);
    expect(nfts.map((n) => n.nft_id).sort()).toEqual(NFT_IDS);
    expect(nfts).toEqual(await nftsOf(reference));
    const holdings = await holdingsOf(ch);
    expect(holdings.length).toBeGreaterThan(0);
    expect(holdings).toEqual(await holdingsOf(reference));
    // the holding moved from the seller to the buyer
    expect(holdings.filter((h) => h.nft_id === SOLD).map((h) => [h.owner, h.held])).toEqual([
      [SELLER, 0],
      [BUYER, 1],
    ]);
    expect(nfts.find((n) => n.nft_id === SOLD)).toMatchObject({ owner: BUYER, sale_count: 1, last_sale_amount: '10' });

    // a second tick, and a restarted aggregator, rebuild nothing: the cursor is in the tables
    const rows = await count(ch, Table.Nfts);
    expect(rows).toBe(NFT_IDS.length);
    await svc.tick(NOW);
    expect(await count(ch, Table.Nfts)).toBe(rows);
    const restarted = aggregator(ch);
    await catchUp(restarted);
    expect(await count(ch, Table.Nfts)).toBe(rows);
    expect(restarted.errors).not.toHaveBeenCalled();
  });

  /** Ticks (at most `most`) until `done` says so. */
  async function tickUntil(svc: AggregatorService, done: () => boolean, most = 20): Promise<void> {
    for (let ticks = 0; ticks < most && !done(); ticks++) {
      await svc.tick(NOW);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(done()).toBe(true);
  }

  it('a fresh database: the first window starts at the ledger before the first one stored, and a long stretch with nothing in it is crossed one window at a time', async () => {
    const ch = await fresh(false);
    const reads: Array<[number, number | undefined]> = [];
    const firstAsked = jest.fn(firstCommittedLedger);
    const { svc, metrics, errors } = aggregator(ch, {
      nftStateFunctions: {
        changedSince: async (db, ledger, limit, to) => {
          reads.push([ledger, to]);
          return nftsChangedSince(db, ledger, limit, to);
        },
        firstLedger: firstAsked,
      },
    });
    // the cursor is read from a database with no ledger (0), and the job then waits for the first ledger
    await tickUntil(svc, () => firstAsked.mock.calls.length > 0);
    expect(reads).toEqual([]);
    for (const lag of valuesOf(metrics.nftStateLagLedgers)) expect(lag).toBe(0);

    // the ledgers come, and the newest committed ledger is far past the recorded ones: 40,000 ledgers to go over after them
    await new LedgerWriter(ch, ctx).write(LEDGERS);
    const head = LAST_LEDGER + 4 * NFT_LIVE_STEP_LEDGERS + 123;
    await ch.insert(Table.Ledgers, [{ ledger_index: head, ledger_hash: 'F'.repeat(64), close_time: NEWEST_CLOSE + 1 }]);
    expect(await catchUp({ svc, metrics })).toBeLessThanOrEqual(3);
    expect(valuesOf(metrics.nftStateLagLedgers).at(-1)).toBe(0);
    expect(errors).not.toHaveBeenCalled();

    // from the ledger before the oldest stored ledger (not from 0), a window of NFT_LIVE_STEP_LEDGERS at a time, up to the head
    expect(reads.map(([ledger]) => ledger)).toEqual(
      [0, 1, 2, 3, 4, 5].map((window) => FIRST_LEDGER - 1 + window * NFT_LIVE_STEP_LEDGERS),
    );
    for (const [ledger, to] of reads) expect(to).toBe(ledger + NFT_LIVE_STEP_LEDGERS);
    // the lag was never the whole head
    for (const lag of valuesOf(metrics.nftStateLagLedgers)) expect(lag).toBeLessThan(head - FIRST_LEDGER + 1);
    expect((await nftsOf(ch)).map((n) => n.nft_id).sort()).toEqual(NFT_IDS);
    expect(await dirtyRanges(ch)).toEqual([]);
  });

  it('a restart over NFTs that a backfill wrote and that have no row yet: the live cursor starts near the head, and the stretch is left to nft_dirty', async () => {
    const ch = await fresh(false);
    // the live sync is at `head`, and the job has caught up with it
    const head = LAST_LEDGER + 4 * NFT_LIVE_STEP_LEDGERS + 123;
    await ch.insert(Table.Ledgers, [{ ledger_index: head, ledger_hash: 'F'.repeat(64), close_time: NEWEST_CLOSE + 1 }]);
    const first = aggregator(ch);
    await catchUp(first);
    expect(await count(ch, Table.Nfts)).toBe(0);

    // a backfill writes the recorded ledgers below the cursor: their NFTs have no row yet, so they are stale (not yet marked)
    await new LedgerWriter(ch, ctx).write(LEDGERS);
    expect(await nftDirtyLedgers(ch)).toBe(0);

    // a restart: the oldest stale touch is far below the head
    const reads: number[] = [];
    const marks: Array<[number, number]> = [];
    const restarted = aggregator(ch, {
      nftStateFunctions: {
        changedSince: async (db, ledger, limit, to) => {
          reads.push(ledger);
          return nftsChangedSince(db, ledger, limit, to);
        },
        markDirty: async (db, from, to) => {
          marks.push([from, to]);
          return markNftDirty(db, from, to);
        },
      },
    });
    await tickUntil(restarted.svc, () => reads.length > 0);
    // (watermark, head] is marked before the live cursor is set, and the live part starts at the head: it does not cross the backfill
    expect(marks).toEqual([[FIRST_LEDGER, head]]);
    expect(reads.every((ledger) => ledger >= head)).toBe(true);
    // the lag is that of the live cursor, never the whole head nor the backfill
    for (const lag of valuesOf(restarted.metrics.nftStateLagLedgers)) expect(lag).toBeLessThan(NFT_LIVE_STEP_LEDGERS);

    // the dirty sweep carries the backlog: every recorded NFT is built, and nft_dirty empties
    await catchUp(restarted, 10);
    expect(restarted.errors).not.toHaveBeenCalled();
    expect(await dirtyRanges(ch)).toEqual([]);
    expect(valuesOf(restarted.metrics.nftDirtyLedgers).at(-1)).toBe(0);
    expect((await nftsOf(ch)).map((n) => n.nft_id).sort()).toEqual(NFT_IDS);
    expect(reads.every((ledger) => ledger >= head)).toBe(true);
    // and a restart after that finds nothing behind the head: nothing is marked again
    const again = aggregator(ch, {
      nftStateFunctions: {
        markDirty: async (db, from, to) => {
          marks.push([from, to]);
          return markNftDirty(db, from, to);
        },
      },
    });
    await catchUp(again);
    expect(marks).toEqual([[FIRST_LEDGER, head]]);
  });

  describe('the nft_collections job', () => {
    it('fills nft_collections and nft_collection_holders for every recorded collection', async () => {
      expect(COLLECTIONS.length).toBeGreaterThan(2);
      const ch = await fresh();
      // the same ledgers in a world of their own, in which the NFTs and then the collections are made by the functions the jobs call
      const reference = await fresh();
      await rebuildNfts(reference, (await nftsChangedSince(reference, 0, 10_000)).nfts);
      await recomputeCollections(reference, new DailyRates(reference, new RatesService(reference, 'XRP')), COLLECTIONS);

      expect(await count(ch, Table.NftCollections)).toBe(0);
      const running = aggregator(ch);
      await computeCollections(running);
      expect(running.errors).not.toHaveBeenCalled();
      expect(running.metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(running.metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'nft_collections' });
      // the queue is empty at the end of every run that had something to do
      expect(valuesOf(running.metrics.nftCollectionsPending).at(-1)).toBe(0);

      // every collection has its row, and what the job wrote is what a direct recompute of the same collections writes
      const collections = await collectionsOf(ch);
      expect(collections.map((c) => [c.issuer, c.taxon_key])).toEqual(COLLECTIONS.map((c) => [c.issuer, c.taxon_key]));
      expect(withoutVersion(collections)).toEqual(withoutVersion(await collectionsOf(reference)));
      const holders = await collectionHoldersOf(ch);
      expect(holders.length).toBeGreaterThan(0);
      expect(holders).toEqual(await collectionHoldersOf(reference));

      // and what the rows say is what the events and the NFTs say
      const nfts = await nftsOf(ch);
      for (const c of collections) {
        const events = EVENTS.filter((e) => e.issuer === c.issuer && e.taxon_key === c.taxon_key);
        const kinds = (event: string): number => events.filter((e) => e.event === event).length;
        expect([Number(c.minted), Number(c.burned), Number(c.sales_count)]).toEqual([
          kinds('mint'),
          kinds('burn'),
          kinds('sale'),
        ]);
        const held = nfts.filter((n) => n.issuer === c.issuer && n.taxon_key === c.taxon_key && !n.burned);
        expect(Number(c.supply)).toBe(held.length);
        const owners = holders.filter((h) => h.issuer === c.issuer && h.taxon_key === c.taxon_key && h.held > 0);
        expect(Number(c.holders)).toBe(owners.length);
        expect(owners.reduce((sum, h) => sum + h.held, 0)).toBe(held.filter((n) => n.owner !== '').length);
      }
      // the collection of the NFT that was sold for 10 XRP has the sale in its volume
      const sold = EVENTS.find((e) => e.nft_id === SOLD) as NftEventsRow;
      const soldCollection = collections.find((c) => c.issuer === sold.issuer && c.taxon_key === sold.taxon_key);
      expect(Number(soldCollection?.sales_count)).toBeGreaterThanOrEqual(1);
      expect(Number(soldCollection?.volume_native_f)).toBeGreaterThanOrEqual(10);
      expect(soldCollection?.volume_native).toMatch(/^\d+(\.\d*[1-9])?$/);
    });

    it('refills the queue at start', async () => {
      const ch = await fresh();
      await computeCollections(aggregator(ch));
      const before = await collectionsOf(ch);
      expect(before.length).toBe(COLLECTIONS.length);
      expect(await collectionsBehind(ch)).toEqual([]);

      // one collection goes stale (one of its NFTs is rebuilt: a newer version in `nfts`), another loses its row
      const sold = EVENTS.find((e) => e.nft_id === SOLD) as NftEventsRow;
      const stale: CollectionKey = { issuer: sold.issuer, taxon_key: sold.taxon_key };
      const lost = COLLECTIONS.find((c) => byCollection(c, stale) !== 0) as CollectionKey;
      await rebuildNfts(ch, [{ issuer: sold.issuer, taxon_key: sold.taxon_key, serial: sold.serial, nft_id: SOLD }]);
      await ch.command(
        `DELETE FROM ${Table.NftCollections} WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32}`,
        { ...lost },
        SYNC_DELETE,
      );
      // and rows are left of a collection that has no NFT any more (its NFTs were removed, and the process stopped)
      const ghost: CollectionKey = { issuer: 'rSyntheticGhostIssuer', taxon_key: 3 };
      const ghostRow: NftCollectionsRow = {
        ...ghost,
        kind: 'nftoken',
        taxon: 3,
        supply: 5,
        holders: 1,
        minted: 5,
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
        version: Date.now(),
      };
      await ch.insert(Table.NftCollections, [ghostRow]);
      await ch.insert(Table.NftCollectionHolders, [
        { ...ghost, owner: 'rSyntheticGhostOwner', held: 5, version: Date.now() },
      ]);
      expect(await collectionsBehind(ch)).toEqual([stale, lost, ghost].sort(byCollection));

      // a new process: nothing is in its queue but what the tables say is behind. The read of that is started by its first run,
      // which does not wait for it, and the collections are computed at the next run of the job (the fifth tick)
      const restarted = aggregator(ch);
      for (let ticks = 0; ticks <= NFT_COLLECTIONS_EVERY_TICKS; ticks++) await restarted.svc.tick(NOW);
      expect(restarted.errors).not.toHaveBeenCalled();
      expect(restarted.metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(valuesOf(restarted.metrics.nftCollectionsPending)).toEqual([0, 0]);
      expect(await collectionsBehind(ch)).toEqual([]);
      // the rows of the collection with no NFT are gone
      expect(await count(ch, Table.NftCollections, `issuer = '${ghost.issuer}'`)).toBe(0);
      expect(await count(ch, Table.NftCollectionHolders, `issuer = '${ghost.issuer}'`)).toBe(0);
      const after = await collectionsOf(ch);
      expect(after.map((c) => [c.issuer, c.taxon_key])).toEqual(before.map((c) => [c.issuer, c.taxon_key]));
      for (const [i, row] of after.entries()) {
        const was = before[i];
        const redone = [stale, lost].some((c) => byCollection(c, row) === 0);
        // the two that were behind are written again, to what they were; the others are not touched
        expect(redone ? row.version > was.version : row.version === was.version).toBe(true);
        expect(withoutVersion([row])).toEqual(withoutVersion([was]));
      }
    });
  });

  describe('120,000 NFTs of one owner', () => {
    /** Events made by hand and their touches, 50 NFTs to a ledger, and the `ledgers` rows that commit them. */
    async function syntheticWorld(): Promise<ClickHouseService> {
      const ch = await fresh(false);
      await ch.command(
        `INSERT INTO ${Table.NftEvents}
           (nft_id, ledger_index, tx_index, event_index, tx_hash, tx_type, close_time, kind, event, issuer, taxon, taxon_key,
            serial, nft_flags, uri, account, to_account)
         SELECT leftPad(hex(number), 64, '0'), toUInt32({first:UInt32} + intDiv(number, {per:UInt32})),
                toUInt32(number % {per:UInt32}), 0, concat('synthetic-', toString(number)), 'NFTokenMint',
                toDateTime({t0:UInt32} + intDiv(number, {per:UInt32}) * 4, 'UTC'), 'nftoken', 'mint', {issuer:String}, 7, 7,
                toUInt32(number), 8, 'AAAA', {issuer:String}, {owner:String}
           FROM numbers({n:UInt64})`,
        {
          first: SYNTHETIC_FIRST_LEDGER,
          per: SYNTHETIC_PER_LEDGER,
          t0: SYNTHETIC_T0,
          issuer: SYNTHETIC_ISSUER,
          owner: SYNTHETIC_OWNER,
          n: SYNTHETIC_NFTS,
        },
      );
      await ch.command(
        `INSERT INTO ${Table.NftTouches} (ledger_index, tx_index, nft_id, issuer, taxon_key, serial)
         SELECT ledger_index, tx_index, nft_id, issuer, taxon_key, serial FROM ${Table.NftEvents}`,
      );
      await ch.command(
        `INSERT INTO ${Table.Ledgers} (ledger_index, ledger_hash, close_time)
         SELECT toUInt32({first:UInt32} + number), leftPad(toString({first:UInt32} + number), 64, 'C'),
                toDateTime({t0:UInt32} + number * 4, 'UTC')
           FROM numbers({n:UInt64})`,
        { first: SYNTHETIC_FIRST_LEDGER, t0: SYNTHETIC_T0, n: SYNTHETIC_LEDGERS },
      );
      return ch;
    }

    it('rebuilds 120,000 NFTs of one owner across ticks, each tick within its budget', async () => {
      const ch = await syntheticWorld();
      expect(await count(ch, Table.NftEvents)).toBe(SYNTHETIC_NFTS);
      const now = new Date((SYNTHETIC_T0 + SYNTHETIC_LEDGERS * 4 + 7200) * 1000);

      // the start of every batch of a tick, and how long a batch took
      const started: number[] = [];
      const took: number[] = [];
      const { svc, metrics, errors } = aggregator(ch, {
        nftStateFunctions: {
          rebuild: async (db, keys, options) => {
            const start = Date.now();
            started.push(start);
            const done = await rebuildNfts(db, keys, options);
            took.push(Date.now() - start);
            return done;
          },
        },
      });

      const ticks: Array<{ batches: number; lateStart: number; ms: number }> = [];
      for (let i = 0; i < 100 && valuesOf(metrics.nftStateLagLedgers).at(-1) !== 0; i++) {
        started.length = 0;
        const tickStart = Date.now();
        await svc.tick(now);
        // no batch starts at or after the budget of the job: a tick is the budget and the batch in flight at its end
        ticks.push({
          batches: started.length,
          lateStart: Math.max(0, ...started.map((at) => at - tickStart)),
          ms: Date.now() - tickStart,
        });
      }

      expect(errors).not.toHaveBeenCalled();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      // 120,000 NFTs are 240 batches of 500, over as many ticks as the budget takes; the lag falls until it is 0
      expect(took).toHaveLength(SYNTHETIC_NFTS / NFT_STATE_BATCH);
      const lag = valuesOf(metrics.nftStateLagLedgers);
      expect(lag.at(-1)).toBe(0);
      expect(lag).toEqual([...lag].sort((a, b) => b - a));
      for (const [i, tick] of ticks.entries()) {
        // (the job starts a moment after the tick does: half a second is for that and for a busy machine)
        expect([i, tick.lateStart < AGGREGATOR_NFT_STATE_BUDGET_MS + 500]).toEqual([i, true]);
        // the whole tick: the budget, the longest batch, and the reads and the stats around it
        expect([i, tick.ms < AGGREGATOR_NFT_STATE_BUDGET_MS + Math.max(...took) + 2000]).toEqual([i, true]);
      }
      // (the first tick only starts the read of the cursor, and the last one has what is left)
      expect(ticks.slice(1, -1).every((t) => t.batches >= 1)).toBe(true);

      // every NFT has its row, and its owner holds it: 120,000 rows and one holding each
      const stored = await ch.queryOne<{ n: number | string; rows: number | string }>(
        `SELECT uniqExact(nft_id) AS n, count() AS rows FROM ${Table.Nfts}`,
      );
      expect([Number(stored?.n), Number(stored?.rows)]).toEqual([SYNTHETIC_NFTS, SYNTHETIC_NFTS]);
      const held = await ch.queryOne<{ n: string }>(
        `SELECT count() AS n FROM (
           SELECT held FROM ${Table.AccountNfts} WHERE owner = {owner:String}
            ORDER BY owner, ${KEY}, version DESC LIMIT 1 BY owner, ${KEY}
         ) WHERE held = 1`,
        { owner: SYNTHETIC_OWNER },
      );
      expect(Number(held?.n)).toBe(SYNTHETIC_NFTS);
      const others = await ch.queryOne<{ n: number | string }>(
        `SELECT count() AS n FROM ${Table.Nfts} WHERE owner != {owner:String}`,
        { owner: SYNTHETIC_OWNER },
      );
      expect(Number(others?.n)).toBe(0);

      // and nothing is left to do: another tick rebuilds nothing
      const batches = started.length;
      await svc.tick(now);
      expect(started.length).toBe(batches);
    });
  });

  describe('a range-ingest --reprocess', () => {
    /** The world of parser 4: the NFT ledgers are there, with no row in the NFT tables and the version that wrote no NFT events. */
    async function parserFourWorld(): Promise<ClickHouseService> {
      const ch = await fresh();
      for (const table of NFT_LEDGER_TABLES) await ch.command(`DELETE FROM ${table} WHERE 1`, {}, SYNC_DELETE);
      await ch.command(
        `ALTER TABLE ${Table.Ledgers} UPDATE parser_version = 4 WHERE ledger_index BETWEEN {first:UInt32} AND {last:UInt32}`,
        { first: FIRST_LEDGER, last: LAST_LEDGER },
        { settings: { mutations_sync: '2' } },
      );
      return ch;
    }

    it('a range-ingest --reprocess marks nft_dirty and the dirty path rebuilds it', async () => {
      const ch = await parserFourWorld();
      const { svc, metrics, errors } = aggregator(ch);
      // the job has run on the world of parser 4: nothing to rebuild, and its cursor is at the head
      await catchUp({ svc, metrics });
      expect(await count(ch, Table.Nfts)).toBe(0);
      expect(await count(ch, Table.NftEvents)).toBe(0);

      const result = await rangeIngest(new FixtureLedgerSource(LEDGERS), ch, ctx, {
        from: FIRST_LEDGER,
        to: LAST_LEDGER,
        indexes: LEDGERS.map((l) => l.header.ledger_index),
        reprocess: true,
        ...FAST,
      });
      expect(result.ledgers).toBe(LEDGERS.length);
      expect(await count(ch, Table.Ledgers, `parser_version = ${PARSER_VERSION}`)).toBe(LEDGERS.length);
      expect(await count(ch, Table.NftTouches)).toBeGreaterThan(0);
      expect((await readDirtyRanges(ch, 100)).length).toBeGreaterThan(0);

      // the reprocess wrote its touches behind the cursor, which does not look back: nothing is rebuilt by the live part, and the
      // hook of the tick that drains agg_dirty marks the ledgers of its slices in nft_dirty
      await svc.tick(NOW);
      expect(await readDirtyRanges(ch, 100)).toEqual([]);
      const marked = await dirtyRanges(ch);
      expect(marked.length).toBeGreaterThan(0);
      for (const [from, to] of marked) expect([from >= FIRST_LEDGER, to <= LAST_LEDGER]).toEqual([true, true]);
      expect(await count(ch, Table.Nfts)).toBe(0);
      expect(await nftDirtyLedgers(ch)).toBeGreaterThan(0);

      // the next tick works on them
      await svc.tick(NOW);
      expect(await dirtyRanges(ch)).toEqual([]);
      expect(await nftDirtyLedgers(ch)).toBe(0);
      expect(valuesOf(metrics.nftDirtyLedgers).at(-1)).toBe(0);
      expect((await nftsOf(ch)).map((n) => n.nft_id).sort()).toEqual(NFT_IDS);
      const holdings = await holdingsOf(ch);
      expect(holdings.filter((h) => h.nft_id === SOLD).map((h) => [h.owner, h.held])).toEqual([
        [SELLER, 0],
        [BUYER, 1],
      ]);
      expect(errors).not.toHaveBeenCalled();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('the dirty path survives a restart mid-range', async () => {
      const ch = await fresh();
      // the job has built every NFT
      const first = aggregator(ch);
      await catchUp(first);
      expect(await count(ch, Table.Nfts)).toBe(NFT_IDS.length);

      // a re-ingest drops the events of two NFTs: one in the first step of ledgers of the range, one in the second
      const ledgersOf = new Map<string, number[]>();
      for (const e of EVENTS) ledgersOf.set(e.nft_id, [...(ledgersOf.get(e.nft_id) ?? []), e.ledger_index]);
      const secondStart = FIRST_LEDGER + NFT_DIRTY_STEP_LEDGERS;
      const inFirst = NFT_IDS.find((id) => (ledgersOf.get(id) as number[]).every((l) => l < secondStart)) as string;
      const inSecond = NFT_IDS.find((id) => (ledgersOf.get(id) as number[]).every((l) => l >= secondStart)) as string;
      expect([inFirst, inSecond].every((id) => id !== undefined)).toBe(true);
      expect(LAST_LEDGER - FIRST_LEDGER + 1).toBeGreaterThan(NFT_DIRTY_STEP_LEDGERS);
      for (const table of [Table.NftEvents, Table.NftTouches]) {
        await ch.command(
          `DELETE FROM ${table} WHERE nft_id IN {ids:Array(String)}`,
          { ids: [inFirst, inSecond] },
          SYNC_DELETE,
        );
      }
      await markNftDirty(ch, FIRST_LEDGER, LAST_LEDGER);
      expect(await dirtyRanges(ch)).toEqual([[FIRST_LEDGER, LAST_LEDGER]]);

      // a process that stops after one step: the range is narrowed to what is left of it
      let stopping: AggregatorService | undefined;
      const stopAfterAStep = aggregator(ch, {
        nftStateFunctions: {
          narrowDirty: async (db, range, from) => {
            await narrowNftDirty(db, range, from);
            void stopping?.stop();
          },
        },
      });
      stopping = stopAfterAStep.svc;
      await stopAfterAStep.svc.tick(NOW);
      expect(stopAfterAStep.errors).not.toHaveBeenCalled();
      expect(await dirtyRanges(ch)).toEqual([[secondStart, LAST_LEDGER]]);
      const idsAfterFirst = (await nftsOf(ch)).map((n) => n.nft_id);
      expect(idsAfterFirst).not.toContain(inFirst);
      expect(idsAfterFirst).toContain(inSecond);

      // a new process finishes the range from its remainder
      const second = aggregator(ch);
      await second.svc.tick(NOW);
      expect(second.errors).not.toHaveBeenCalled();
      expect(await dirtyRanges(ch)).toEqual([]);
      expect(await nftDirtyLedgers(ch)).toBe(0);
      expect((await nftsOf(ch)).map((n) => n.nft_id).sort()).toEqual(
        NFT_IDS.filter((id) => id !== inFirst && id !== inSecond),
      );
      // and their holdings are gone with them
      const held = (await holdingsOf(ch)).filter((h) => h.held === 1 && [inFirst, inSecond].includes(h.nft_id));
      expect(held).toEqual([]);
    });
  });
});
