import {
  AccountNftEventsRow,
  buildLedgerRows,
  clickHouseConfigFromEnv,
  ClickHouseService,
  computeDailyVolumeSet,
  computeLiveVolumeSet,
  DailyRates,
  getNetworkProfile,
  MarketsConfig,
  NFT_LIVE_PERIODS,
  NFT_STATE_BATCH,
  NftEventsRow,
  nftsChangedSince,
  NftTouchesRow,
  parseContextFor,
  ParsedNftEvent,
  RatesService,
  rebuildNfts,
  recomputeCollections,
  rolesOf,
  Table,
} from '@gatehub/data-api-shared';
import { clickHouseUrl } from '../e2e-env';
import type { Harness } from '../harness';
import { fixtureSource, SEED_NETWORK, SeedName } from './fixtures';

/**
 * Helpers the NFT e2e suites share (`nfts`, and the collection, account and sales suites that follow): the events of a seed as
 * the parser builds them, events made by hand, and the aggregates built over a seed.
 */

/** Every `nft_events` row a fixture set is stored as, in the order of the ledgers and of their transactions. */
export function fixtureNftEvents(seed: SeedName): NftEventsRow[] {
  const ctx = parseContextFor(getNetworkProfile(SEED_NETWORK[seed]));
  return fixtureSource(seed)
    .list()
    .flatMap((ledger) => buildLedgerRows(ledger, ctx).nftEvents);
}

/**
 * An event made by hand: a mint of an XRPL NFT to `rSyntheticOwner`, every other column at its absent value, unless `over` names
 * it. Its transaction says `synthetic-…` (a hand-made event is never presented as a recorded one).
 */
export function nftEventRow(over: Partial<NftEventsRow> = {}): NftEventsRow {
  const ledger = over.ledger_index ?? 107_874_617;
  return {
    nft_id: '00080000AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA00000000000000000000F001',
    ledger_index: ledger,
    tx_index: 1000,
    event_index: 0,
    tx_hash: `synthetic-${ledger}-${over.tx_index ?? 1000}-${over.event_index ?? 0}`,
    tx_type: 'NFTokenMint',
    close_time: 1_792_858_092,
    kind: 'nftoken',
    event: 'mint',
    issuer: 'rSyntheticIssuer',
    taxon: 1,
    taxon_key: 1,
    serial: 61_441,
    nft_flags: 8,
    transfer_fee: 5000,
    uri: '697066733A2F2F73796E746865746963',
    digest: '',
    account: 'rSyntheticOwner',
    from_account: '',
    to_account: 'rSyntheticOwner',
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

/**
 * The copy of an event for each account it involves, as the ingest writes them (`account_nft_events`): the columns of the event,
 * `actor` the account that did it, `account` the account the row is for, and its `roles` (spec 2.6, in `NFT_ROLES` order; an
 * account with two roles in an event has one row).
 */
function accountNftEventRows(r: NftEventsRow): AccountNftEventsRow[] {
  const { account: actor, ...columns } = r;
  return [...rolesOf(r as ParsedNftEvent)].map(([account, roles]) => ({
    ...columns,
    account,
    actor,
    roles: [...roles],
  }));
}

/**
 * Writes events made by hand to the ledger tables an ingest writes them to (`nft_events`, its copies by account, by collection
 * and, for the sales, in ledger order, and the touches the aggregator scans). The ledgers they are in have to be committed
 * (`ledgers`) to be read: put them in ledgers of the seed. Rows of one call with the same key are collapsed on insert; a row
 * written twice, as a re-ingest can leave it, is two calls.
 */
export async function insertNftEvents(h: Harness, rows: NftEventsRow[]): Promise<void> {
  await h.ch.insert(Table.NftEvents, rows);
  await h.ch.insert(Table.AccountNftEvents, rows.flatMap(accountNftEventRows));
  await h.ch.insert(
    Table.CollectionNftEvents,
    rows.map((r) => ({ ...r })),
  );
  await h.ch.insert(
    Table.NftSales,
    rows.filter((r) => r.event === 'sale').map((r) => ({ ...r })),
  );
  const touches = new Map<string, NftTouchesRow>();
  for (const r of rows) {
    touches.set(`${r.ledger_index}:${r.tx_index}:${r.nft_id}`, {
      ledger_index: r.ledger_index,
      tx_index: r.tx_index,
      nft_id: r.nft_id,
      issuer: r.issuer,
      taxon_key: r.taxon_key,
      serial: r.serial,
    });
  }
  await h.ch.insert(Table.NftTouches, [...touches.values()]);
}

const DAY_SECONDS = 86_400;
/** The NFT volume does not read the markets configuration. */
const NO_MARKETS: MarketsConfig = { version: 1, tradeMarkets: [], paymentCurrencies: [] };

/**
 * A connection of its own to the harness's database, made here and not taken from the harness. The harness builds the app in
 * a module registry of its own (`jest.isolateModulesAsync`), so the client of `h.ch` does not know the `TupleParam` that the
 * aggregator functions of the shared package, loaded by this file, bind their keys with: it would send the object as text.
 */
function connect(h: Harness): ClickHouseService {
  return new ClickHouseService(
    clickHouseConfigFromEnv({
      GH_CLICKHOUSE_URL: clickHouseUrl(),
      GH_CLICKHOUSE_USER: 'default',
      GH_CLICKHOUSE_PASSWORD: '',
      GH_CLICKHOUSE_DATABASE: h.database,
    }),
  );
}

/**
 * Builds the NFT aggregates over what the database holds, as the aggregator would have by the end: every NFT with an event is
 * rebuilt (`nfts`, `account_nfts`), then every collection they name (`nft_collections`, `nft_collection_holders`), and the
 * `nft_volume` sets are written: the live ones as of a second after the newest ledger closed, and the daily ones of each UTC
 * day between the oldest and the newest. `native` is the native currency of the network (the rates are against it).
 */
export async function buildNftAggregates(h: Harness, native = 'XRP'): Promise<void> {
  const ch = connect(h);
  try {
    const rates = new RatesService(ch, native);
    const daily = new DailyRates(ch, rates);

    const collections = new Map<string, { issuer: string; taxon_key: number }>();
    let cursor = 0;
    for (;;) {
      const changed = await nftsChangedSince(ch, cursor, NFT_STATE_BATCH);
      if (changed.nfts.length > 0) {
        for (const key of (await rebuildNfts(ch, changed.nfts)).collections) {
          collections.set(`${key.issuer}/${key.taxon_key}`, key);
        }
      }
      if (changed.upTo <= cursor) break;
      cursor = changed.upTo;
    }
    await recomputeCollections(ch, daily, [...collections.values()]);

    const closed = await ch.queryOne<{ first: number | string; last: number | string }>(
      `SELECT toUnixTimestamp(min(close_time)) AS first, toUnixTimestamp(max(close_time)) AS last FROM ${Table.Ledgers}`,
    );
    if (closed === undefined) return;
    const [first, last] = [Number(closed.first), Number(closed.last)];
    for (const period of NFT_LIVE_PERIODS) {
      await computeLiveVolumeSet(ch, rates, NO_MARKETS, 'nft_volume', period, new Date((last + 1) * 1000));
    }
    for (let day = Math.floor(first / DAY_SECONDS); day <= Math.floor(last / DAY_SECONDS); day++) {
      await computeDailyVolumeSet(ch, rates, NO_MARKETS, 'nft_volume', new Date(day * DAY_SECONDS * 1000));
    }
  } finally {
    await ch.onModuleDestroy();
  }
}
