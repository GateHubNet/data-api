import { join } from 'node:path';
import { committedHead } from '../src/aggregate/amm-pools.job';
import {
  MPT_HOLDERS_CHUNK,
  MPT_HOLDERS_READ_CHUNK,
  MPT_STATE_BATCH,
  mptIssuancesChangedSince,
  mptIssuancesClosedIn,
  MptStale,
  MptStateAborted,
  mptStateWatermark,
  rebuildMptIssuances,
  recomputeMptHolders,
  recomputeMptIssuances,
} from '../src/aggregate/mpt-state.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { MptHolderStatesRow, MptIssuanceStatesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { LSF_MPT_LOCKED } from '../src/parsers/mpt.parser';
import { parseContextFor } from '../src/parsers/parser.interface';
import { RatesService } from '../src/query/rates.service';
import { mptIssuanceId, mptIssuerOf } from '../src/util/mpt';
import {
  cutText,
  decodeMptMetadata,
  MPT_NAME_MAX,
  MPT_TICKER_MAX,
  mptMetadataConforms,
} from '../src/util/mpt-metadata';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The `mpt_state` job's functions on a real ClickHouse.
 *
 * Part 1 rebuilds every issuance of the recorded XRPL ledgers (`fixtures/xrpl/mpt`, written through the real `LedgerWriter`) and
 * compares each with an oracle that reads the state rows in plain JavaScript. Part 2 is the rebuild on state rows made by hand
 * (their transactions are `synthetic-…`): the locks, the removals, the versions, the head and the abort. Part 3 is what to rebuild.
 * Part 4 is what an issuance's `last_ledger` claims: every pair touched below it was rebuilt, whichever path rebuilt the issuance.
 * Part 5 is the size of a rebuild: the chunks, 120,000 holders, and what a read costs against a bulk.
 */

const T0 = 1_760_000_000;
const SEC = 1000;
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;
/** Every UInt64 as text and every time as unix seconds, so that a stored row compares with one worked out here. */
const AS_TEXT = { output_format_json_quote_64bit_integers: 1, date_time_output_format: 'unix_timestamp' } as const;

const ctx = parseContextFor(getNetworkProfile('xrpl'));
const MPT_LEDGERS = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/mpt')).list();
const MPT_BUILT = MPT_LEDGERS.map((raw) => buildLedgerRows(raw, ctx));

// Recorded (test/fixtures/xrpl/mpt/manifest.json)
const CREATED = '03F907F270631F5CC5E1A2E556F42D017F52CEE7EA30AF80'; // issuance_create
const CREATE_HASH = '68D137B937AE7C6EF558DBDDC307B3BC6FADEB3C2F038DDAA3D36BF93C1FDF9E';
const RAW_METADATA = '0630D1509457BB4DAC6428F49FDC6CDE60AF0E07BA7A3733'; // issuance_create_raw_metadata
const NO_MAX = '05FC5D62D3D74E31D901BBC29F79AAA07911B0274AFA9CE9'; // issuance_create_no_max
const DESTROYED = '064E273A6D15D1F5614B4D4E3183F835BCD62E7F6FD9FFD8'; // issuance_destroy, with the holder's token deleted too
const ESCROWED = '0663EB64E8DDA74A98C6C70B740E67C7A2D1509EE78C163A'; // escrow_create and escrow_finish, three holders
const LOCK_HOLDER = '0663EACAC1E295FCE4BA9E9ECD5EC0E84C5089AEE6B00E65'; // issuance_set_lock_holder: holder rows only
const BEFORE_FIX = '060CA3E09B41B8EB574622BE0CDA7BB12D05EB50B60C8EF5'; // payment_before_delivered_fix: no create in the coverage

// By hand: real IDs (the issuer is decoded from them), and holders of a real address's width
const ISSUER = 'rBEERdzDHqDyYmfw2jqzyMNBZu31yzfg6q';
const A = mptIssuanceId(1, ISSUER);
const B = mptIssuanceId(2, ISSUER);
const C = mptIssuanceId(3, ISSUER);
const holderOf = (name: string): string => `r${name}`.padEnd(34, '0');
const H1 = holderOf('One');
const H2 = holderOf('Two');
const H3 = holderOf('Three');

function issuanceState(id: string, ledger: number, over: Partial<MptIssuanceStatesRow> = {}): MptIssuanceStatesRow {
  return {
    mpt_issuance_id: id,
    ledger_index: ledger,
    tx_index: 0,
    node_index: 0,
    tx_hash: `synthetic-${id.slice(0, 8)}-${ledger}`,
    tx_type: 'MPTokenIssuanceSet',
    close_time: T0 + ledger,
    issuer: mptIssuerOf(id),
    sequence: Number.parseInt(id.slice(0, 8), 16),
    flags: 0,
    asset_scale: 0,
    maximum_amount: null,
    outstanding_amount: '0',
    escrowed_amount: '0',
    transfer_fee: 0,
    metadata_hex: '',
    deleted: 0,
    ...over,
  };
}

function holderState(
  id: string,
  holder: string,
  ledger: number,
  over: Partial<MptHolderStatesRow> = {},
): MptHolderStatesRow {
  return {
    holder,
    mpt_issuance_id: id,
    ledger_index: ledger,
    tx_index: 0,
    node_index: 0,
    tx_hash: `synthetic-${holder.slice(0, 8)}-${ledger}`,
    tx_type: 'Payment',
    close_time: T0 + ledger,
    amount: '0',
    escrowed_amount: '0',
    flags: 0,
    deleted: 0,
    ...over,
  };
}

/** A `ledgers` row: just enough for the committed head and for `ledgersClosedIn`. */
const ledgerRow = (ledger_index: number) => ({
  ledger_index,
  ledger_hash: `${ledger_index}`.padStart(64, 'C'),
  close_time: T0 + ledger_index,
});

/** State rows and the touches that go with them, not committed: no `ledgers` row, as while the writer is at them. */
async function insertUncommitted(
  ch: ClickHouseService,
  issuances: MptIssuanceStatesRow[],
  holders: MptHolderStatesRow[],
): Promise<void> {
  if (issuances.length > 0) await ch.insert(Table.MptIssuanceStates, issuances);
  if (holders.length > 0) await ch.insert(Table.MptHolderStates, holders);
  await ch.insert(Table.MptTouches, [
    ...issuances.map((r) => ({
      ledger_index: r.ledger_index,
      tx_index: r.tx_index,
      mpt_issuance_id: r.mpt_issuance_id,
      holder: '',
    })),
    ...holders.map((r) => ({
      ledger_index: r.ledger_index,
      tx_index: r.tx_index,
      mpt_issuance_id: r.mpt_issuance_id,
      holder: r.holder,
    })),
  ]);
}

/** State rows and their touches in ledgers that are committed, as the ledger writer leaves a ledger it has written. */
async function insertCommitted(
  ch: ClickHouseService,
  issuances: MptIssuanceStatesRow[],
  holders: MptHolderStatesRow[] = [],
): Promise<void> {
  await insertUncommitted(ch, issuances, holders);
  const ledgers = new Set([...issuances, ...holders].map((r) => r.ledger_index));
  await ch.insert(Table.Ledgers, [...ledgers].map(ledgerRow));
}

/** Commits ledgers that hold no MPT row. */
const commit = (ch: ClickHouseService, ...ledgers: number[]): Promise<void> =>
  ch.insert(Table.Ledgers, ledgers.map(ledgerRow));

/** A re-ingest of some ledgers drops these rows. */
async function dropLedger(ch: ClickHouseService, ledger: number): Promise<void> {
  for (const table of [Table.MptIssuanceStates, Table.MptHolderStates, Table.MptTouches]) {
    await ch.command(
      `DELETE FROM ${table} WHERE ledger_index = {ledger:UInt32}`,
      { ledger },
      { settings: SYNC_DELETE },
    );
  }
}

interface StoredIssuance {
  mpt_issuance_id: string;
  issuer: string;
  sequence: number;
  state_known: number;
  flags: number;
  asset_scale: number;
  maximum_amount: string | null;
  outstanding_amount: string;
  escrowed_amount: string;
  locked_amount: string;
  locked_holders: number;
  holders: number;
  transfer_fee: number;
  metadata_hex: string;
  metadata: string;
  metadata_conforms: number;
  ticker: string;
  name: string;
  created_ledger: number | null;
  created_time: number | string | null;
  created_tx_hash: string | null;
  last_ledger: number;
  destroyed: number;
  version: string;
}

interface StoredHolder {
  mpt_issuance_id: string;
  holder: string;
  amount: string;
  escrowed_amount: string;
  flags: number;
  last_ledger: number;
  deleted: number;
  version: string;
}

/** The newest row of each issuance. */
const issuancesOf = (ch: ClickHouseService): Promise<StoredIssuance[]> =>
  ch.query<StoredIssuance>(
    `SELECT * FROM ${Table.MptIssuances} ORDER BY mpt_issuance_id, version DESC LIMIT 1 BY mpt_issuance_id`,
    {},
    AS_TEXT,
  );

const issuanceOf = async (ch: ClickHouseService, id: string): Promise<StoredIssuance> => {
  const row = (await issuancesOf(ch)).find((r) => r.mpt_issuance_id === id);
  if (row === undefined) throw new Error(`issuance ${id} has no row`);
  return row;
};

/** The newest row of each holder of each issuance. */
const holdersOf = (ch: ClickHouseService, id?: string): Promise<StoredHolder[]> =>
  ch.query<StoredHolder>(
    `SELECT * FROM ${Table.MptHolders}
      ${id === undefined ? '' : 'WHERE mpt_issuance_id = {id:String}'}
      ORDER BY mpt_issuance_id, holder, version DESC
      LIMIT 1 BY mpt_issuance_id, holder`,
    id === undefined ? {} : { id },
    AS_TEXT,
  );

const without = <T extends { version: string }>({ version: _version, ...row }: T): Omit<T, 'version'> => row;

/** What the plain reading of the state rows gives for one issuance: the oracle of the recorded ledgers. */
function oracleOf(id: string, head: number): Omit<StoredIssuance, 'version'> {
  const order = (a: { ledger_index: number; tx_index: number; node_index: number }, b: typeof a): number =>
    a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index;
  const states = MPT_BUILT.flatMap((b) => b.mptIssuanceStates)
    .filter((r) => r.mpt_issuance_id === id && r.ledger_index <= head)
    .sort(order);
  const holderRows = MPT_BUILT.flatMap((b) => b.mptHolderStates)
    .filter((r) => r.mpt_issuance_id === id && r.ledger_index <= head)
    .sort(order);
  const newestOfHolder = new Map(holderRows.map((r) => [r.holder, r]));
  const live = [...newestOfHolder.values()].filter(
    (r) => r.deleted === 0 && (BigInt(r.amount) > 0n || BigInt(r.escrowed_amount) > 0n),
  );
  const locked = live.filter((r) => (r.flags & LSF_MPT_LOCKED) !== 0);
  const state = states[states.length - 1];
  const made = states.find((r) => r.tx_type === 'MPTokenIssuanceCreate');
  const decoded = state ? decodeMptMetadata(state.metadata_hex) : undefined;
  const allLocked = state !== undefined && (state.flags & LSF_MPT_LOCKED) !== 0;
  return {
    mpt_issuance_id: id,
    issuer: mptIssuerOf(id),
    sequence: Number.parseInt(id.slice(0, 8), 16),
    state_known: state ? 1 : 0,
    flags: state?.flags ?? 0,
    asset_scale: state?.asset_scale ?? 0,
    maximum_amount: state?.maximum_amount === undefined ? null : (state.maximum_amount as string | null),
    outstanding_amount: String(state?.outstanding_amount ?? '0'),
    escrowed_amount: String(state?.escrowed_amount ?? '0'),
    locked_amount: allLocked
      ? String(state.outstanding_amount)
      : String(locked.reduce((sum, r) => sum + BigInt(r.amount), 0n)),
    locked_holders: allLocked ? live.length : locked.length,
    holders: live.length,
    transfer_fee: state?.transfer_fee ?? 0,
    metadata_hex: state?.metadata_hex ?? '',
    metadata: decoded ? JSON.stringify(decoded) : '',
    metadata_conforms: decoded && mptMetadataConforms(decoded) ? 1 : 0,
    ticker: cutText(decoded?.ticker, MPT_TICKER_MAX),
    name: cutText(decoded?.name, MPT_NAME_MAX),
    created_ledger: made?.ledger_index ?? null,
    created_time: made?.close_time ?? null,
    created_tx_hash: made?.tx_hash ?? null,
    last_ledger: Math.max(state?.ledger_index ?? 0, ...[...newestOfHolder.values()].map((r) => r.ledger_index)),
    destroyed: state?.deleted ?? 0,
  };
}

/** A stored row with its `created_time` as a number: it comes back as text. */
const comparable = (row: StoredIssuance): Omit<StoredIssuance, 'version'> => ({
  ...without(row),
  created_time: row.created_time === null ? null : Number(row.created_time),
});

describe('the mpt_state job (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.close();
    await container?.container.stop();
  });

  /** A migrated database of its own. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `mpt_state_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** The inserts into a table that a spy on the service saw, with the number of rows of each. */
  const insertsInto = (insert: jest.SpyInstance, table: Table): number[] =>
    insert.mock.calls.filter(([into]) => into === table).map(([, rows]) => (rows as unknown[]).length);

  // -------------------------------------------------------------------------------------------------------------------
  describe('the issuances of the recorded ledgers', () => {
    let ch: ClickHouseService;
    let head: number;

    beforeAll(async () => {
      ch = await fresh();
      await new LedgerWriter(ch, ctx).write(MPT_LEDGERS);
      head = await committedHead(ch);
      // as the job goes: from what it finds stale, a batch at a time
      let cursor = await mptStateWatermark(ch);
      for (;;) {
        const { issuances, upTo } = await mptIssuancesChangedSince(ch, cursor, head, MPT_STATE_BATCH);
        await rebuildMptIssuances(ch, issuances, head);
        if (upTo <= cursor) break;
        cursor = upTo;
      }
    });

    it('builds an issuance and its holders from the recorded ledgers', async () => {
      const ids = [
        ...new Set(
          MPT_BUILT.flatMap((b) => [...b.mptIssuanceStates, ...b.mptHolderStates]).map((r) => r.mpt_issuance_id),
        ),
      ].sort();
      const stored = await issuancesOf(ch);
      expect(stored.map((r) => r.mpt_issuance_id)).toEqual(ids);
      for (const row of stored) expect(comparable(row)).toEqual(oracleOf(row.mpt_issuance_id, head));

      // by hand, from the recorded rows: the create with every field
      const created = await issuanceOf(ch, CREATED);
      expect(created).toMatchObject({
        issuer: ISSUER,
        sequence: 66652146,
        state_known: 1,
        flags: 126,
        asset_scale: 4,
        maximum_amount: '1000000000000',
        outstanding_amount: '0',
        transfer_fee: 192,
        holders: 0,
        created_ledger: 99337721,
        created_tx_hash: CREATE_HASH,
        last_ledger: 99337721,
        destroyed: 0,
      });
      expect(created.metadata).toBe(JSON.stringify(decodeMptMetadata(created.metadata_hex)));
      expect(created.metadata).not.toBe('');
      expect(created.metadata_hex).not.toBe('');

      // three holders, whose balances add up to the outstanding amount: the escrows have been finished
      const escrowed = await issuanceOf(ch, ESCROWED);
      expect(escrowed).toMatchObject({
        outstanding_amount: '954219',
        escrowed_amount: '0',
        holders: 3,
        last_ledger: 107211751,
      });
      const holders = await holdersOf(ch, ESCROWED);
      expect(holders.map((h) => h.amount).sort()).toEqual(['277073', '41000', '636146']);
      expect(holders.reduce((sum, h) => sum + BigInt(h.amount), 0n)).toBe(954219n);

      // no maximum is a null, and a state with no create in the coverage has no creation
      expect((await issuanceOf(ch, NO_MAX)).maximum_amount).toBeNull();
      expect(await issuanceOf(ch, BEFORE_FIX)).toMatchObject({
        state_known: 1,
        created_ledger: null,
        created_time: null,
        created_tx_hash: null,
      });

      // and nothing is stale after it
      expect(await mptStateWatermark(ch)).toBe(head);
      expect(await mptIssuancesChangedSince(ch, 0, head, MPT_STATE_BATCH)).toEqual({ issuances: [], upTo: head });
    });

    it('keeps the hex and no metadata for metadata that is not JSON', async () => {
      const row = await issuanceOf(ch, RAW_METADATA);
      expect(row.metadata_hex).not.toBe('');
      expect(decodeMptMetadata(row.metadata_hex)).toBeUndefined();
      expect(row).toMatchObject({ metadata: '', metadata_conforms: 0, ticker: '', name: '' });
    });

    it('marks a destroyed issuance destroyed, and its holder deleted', async () => {
      expect(await issuanceOf(ch, DESTROYED)).toMatchObject({
        destroyed: 1,
        holders: 0,
        outstanding_amount: '0',
        last_ledger: 105916049,
      });
      expect(await holdersOf(ch, DESTROYED)).toEqual([expect.objectContaining({ deleted: 1, amount: '0' })]);
    });

    it('writes state_known 0 for the recorded issuance with holder rows only, with its holders served', async () => {
      expect(await issuanceOf(ch, LOCK_HOLDER)).toMatchObject({
        state_known: 0,
        flags: 0,
        outstanding_amount: '0',
        holders: 1,
        created_ledger: null,
        last_ledger: 107211755,
      });
      expect(await holdersOf(ch, LOCK_HOLDER)).toEqual([expect.objectContaining({ amount: '45000000', flags: 2 })]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('state rows made by hand', () => {
    it('sums the locked holders, and every balance when the issuance is locked', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { outstanding_amount: '10000' })],
        [
          holderState(A, H1, 11, { amount: '100', flags: LSF_MPT_LOCKED }),
          holderState(A, H2, 11, { amount: '30', flags: 2 }), // not locked: another flag
          // locked with its balance all in escrow: it counts as a holder, and its amount adds nothing
          holderState(A, H3, 11, { amount: '0', escrowed_amount: '7', flags: LSF_MPT_LOCKED | 2 }),
          // locked with no balance: not a holder, so not a locked one either
          holderState(A, holderOf('Empty'), 11, { amount: '0', flags: LSF_MPT_LOCKED }),
          // locked, and its MPToken deleted
          holderState(A, holderOf('Gone'), 11, { amount: '5', flags: LSF_MPT_LOCKED, deleted: 1 }),
        ],
      );
      const stale: MptStale[] = [{ id: A, holders: [H1, H2, H3, holderOf('Empty'), holderOf('Gone')] }];
      await rebuildMptIssuances(ch, stale, 11);
      expect(await issuanceOf(ch, A)).toMatchObject({
        outstanding_amount: '10000',
        holders: 3,
        locked_amount: '100',
        locked_holders: 2,
      });

      // the whole issuance locked: its outstanding amount and all its holders, whatever each holder's own flag says
      await insertCommitted(ch, [issuanceState(A, 12, { outstanding_amount: '10000', flags: LSF_MPT_LOCKED | 2 })]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 12);
      expect(await issuanceOf(ch, A)).toMatchObject({
        flags: LSF_MPT_LOCKED | 2,
        holders: 3,
        locked_amount: '10000',
        locked_holders: 3,
      });
    });

    it('keeps amounts above 2^53 exact, and sums them exactly', async () => {
      const ch = await fresh();
      const big = '9007199254740993'; // 2^53 + 1
      const max = '9223372036854775807'; // 2^63 - 1
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { maximum_amount: max, outstanding_amount: max, escrowed_amount: big })],
        [
          holderState(A, H1, 11, { amount: big, flags: LSF_MPT_LOCKED }),
          holderState(A, H2, 11, { amount: big, flags: LSF_MPT_LOCKED }),
          holderState(A, H3, 11, { amount: max, escrowed_amount: max }),
        ],
      );
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 11);
      expect(await issuanceOf(ch, A)).toMatchObject({
        maximum_amount: max,
        outstanding_amount: max,
        escrowed_amount: big,
        locked_amount: '18014398509481986',
        holders: 3,
      });
      const amountOf = new Map((await holdersOf(ch, A)).map((h) => [h.holder, h.amount]));
      expect([amountOf.get(H1), amountOf.get(H2), amountOf.get(H3)]).toEqual([big, big, max]);
    });

    it('writes state_known 0 for an issuance with holder rows only', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [],
        [holderState(B, H1, 20, { amount: '4', flags: LSF_MPT_LOCKED }), holderState(B, H2, 21, { amount: '6' })],
      );
      await rebuildMptIssuances(ch, [{ id: B, holders: [] }], 21);
      expect(comparable(await issuanceOf(ch, B))).toEqual({
        mpt_issuance_id: B,
        issuer: ISSUER,
        sequence: 2,
        state_known: 0,
        flags: 0,
        asset_scale: 0,
        maximum_amount: null,
        outstanding_amount: '0',
        escrowed_amount: '0',
        locked_amount: '4',
        locked_holders: 1,
        holders: 2,
        transfer_fee: 0,
        metadata_hex: '',
        metadata: '',
        metadata_conforms: 0,
        ticker: '',
        name: '',
        created_ledger: null,
        created_time: null,
        created_tx_hash: null,
        last_ledger: 21,
        destroyed: 0,
      });
    });

    it('cuts the ticker to 16 and the name to 128 characters', async () => {
      const ch = await fresh();
      const hexOf = (object: object): string =>
        Buffer.from(JSON.stringify(object), 'utf8').toString('hex').toUpperCase();
      // a character outside the BMP at the cut stays whole
      const ticker = `${'T'.repeat(15)}\u{1F600}TAIL`;
      const name = `${'N'.repeat(127)}\u{1F600}TAIL`;
      await insertCommitted(ch, [issuanceState(A, 10, { metadata_hex: hexOf({ ticker, name }) })]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 10);
      const row = await issuanceOf(ch, A);
      expect(row.ticker).toBe(`${'T'.repeat(15)}\u{1F600}`);
      expect(row.name).toBe(`${'N'.repeat(127)}\u{1F600}`);
      // the decoded object keeps them whole, and they do not conform
      expect(JSON.parse(row.metadata)).toEqual({ ticker, name });
      expect(row.metadata_conforms).toBe(0);
    });

    it('sets metadata_conforms from the decoded object, whichever keys spelled it', async () => {
      const ch = await fresh();
      const hexOf = (object: object): string =>
        Buffer.from(JSON.stringify(object), 'utf8').toString('hex').toUpperCase();
      await insertCommitted(ch, [
        issuanceState(A, 10, {
          metadata_hex: hexOf({ t: 'GOOD', n: 'Good', i: 'https://x/i.png', ac: 'defi', in: 'Issuer' }),
        }),
      ]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 10);
      const row = await issuanceOf(ch, A);
      expect(row).toMatchObject({ metadata_conforms: 1, ticker: 'GOOD', name: 'Good' });
      expect(Object.keys(JSON.parse(row.metadata))).toEqual(['ticker', 'name', 'icon', 'asset_class', 'issuer_name']);
    });

    it('takes the newest state whole: a null maximum and an empty metadata are not filled from an older row', async () => {
      const ch = await fresh();
      await insertCommitted(ch, [
        issuanceState(A, 10, {
          tx_type: 'MPTokenIssuanceCreate',
          maximum_amount: '500',
          metadata_hex: Buffer.from('{"ticker":"OLD"}', 'utf8').toString('hex').toUpperCase(),
        }),
      ]);
      await insertCommitted(ch, [issuanceState(A, 20, { maximum_amount: null, outstanding_amount: '3' })]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 20);
      expect(await issuanceOf(ch, A)).toMatchObject({
        maximum_amount: null,
        outstanding_amount: '3',
        metadata_hex: '',
        metadata: '',
        ticker: '',
        created_ledger: 10,
      });
    });

    it('takes the creation from the oldest create row, and none when the only rows are not creates', async () => {
      const ch = await fresh();
      await insertCommitted(ch, [
        issuanceState(A, 10, { tx_type: 'MPTokenIssuanceCreate', tx_hash: 'synthetic-create-a' }),
      ]);
      await insertCommitted(ch, [issuanceState(A, 20), issuanceState(B, 20)]);
      await rebuildMptIssuances(
        ch,
        [
          { id: A, holders: [] },
          { id: B, holders: [] },
        ],
        20,
      );
      expect(await issuanceOf(ch, A)).toMatchObject({
        created_ledger: 10,
        created_tx_hash: 'synthetic-create-a',
        last_ledger: 20,
      });
      expect(Number((await issuanceOf(ch, A)).created_time)).toBe(T0 + 10);
      expect(await issuanceOf(ch, B)).toMatchObject({
        created_ledger: null,
        created_time: null,
        created_tx_hash: null,
      });
    });

    it('takes the newest of the rows of one ledger by transaction and node', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { tx_index: 1, outstanding_amount: '1' })],
        [holderState(A, H1, 10, { tx_index: 1, amount: '1' })],
      );
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { tx_index: 2, node_index: 1, outstanding_amount: '3' })],
        [holderState(A, H1, 10, { tx_index: 2, node_index: 1, amount: '3' })],
      );
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { tx_index: 2, node_index: 0, outstanding_amount: '2' })],
        [holderState(A, H1, 10, { tx_index: 2, node_index: 0, amount: '2' })],
      );
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 10);
      expect((await issuanceOf(ch, A)).outstanding_amount).toBe('3');
      expect((await holdersOf(ch, A))[0].amount).toBe('3');
    });

    it('keeps a deleted MPToken as deleted, out of the holder count', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { outstanding_amount: '9' })],
        [holderState(A, H1, 10, { amount: '9' }), holderState(A, H2, 10, { amount: '1' })],
      );
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 10);
      expect((await issuanceOf(ch, A)).holders).toBe(2);

      await insertCommitted(ch, [], [holderState(A, H2, 11, { amount: '0', flags: 2, deleted: 1 })]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 11);
      expect((await issuanceOf(ch, A)).holders).toBe(1);
      expect(await holdersOf(ch, A)).toEqual([
        expect.objectContaining({ holder: H1, deleted: 0 }),
        expect.objectContaining({ holder: H2, deleted: 1, amount: '0', flags: 2, last_ledger: 11 }),
      ]);
      // and its touch is what the row has seen
      expect((await issuanceOf(ch, A)).last_ledger).toBe(11);
    });

    it('marks a destroyed issuance destroyed', async () => {
      const ch = await fresh();
      await insertCommitted(ch, [issuanceState(A, 10, { outstanding_amount: '5' })]);
      await insertCommitted(ch, [
        issuanceState(A, 20, { tx_type: 'MPTokenIssuanceDestroy', outstanding_amount: '0', deleted: 1 }),
      ]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 20);
      expect(await issuanceOf(ch, A)).toMatchObject({ destroyed: 1, state_known: 1, outstanding_amount: '0' });
    });

    it('removes an issuance whose rows a re-ingest dropped', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { outstanding_amount: '1' }), issuanceState(B, 11, { outstanding_amount: '2' })],
        [holderState(A, H1, 10, { amount: '1' }), holderState(B, H1, 11, { amount: '2' })],
      );
      await rebuildMptIssuances(
        ch,
        [
          { id: A, holders: [] },
          { id: B, holders: [] },
        ],
        11,
      );
      expect((await issuancesOf(ch)).map((r) => r.mpt_issuance_id)).toEqual([A, B]);

      await dropLedger(ch, 10);
      const command = jest.spyOn(ch, 'command');
      // the hook names the pair (its row last saw the slice), since no touch is left to name it
      await rebuildMptIssuances(ch, [{ id: A, holders: [H1] }], 11);
      expect((await issuancesOf(ch)).map((r) => r.mpt_issuance_id)).toEqual([B]);
      expect((await holdersOf(ch)).map((h) => h.mpt_issuance_id)).toEqual([B]);
      // a lightweight DELETE, synchronous
      const deletes = command.mock.calls.filter(([sql]) => sql.startsWith('DELETE FROM'));
      expect(deletes.length).toBeGreaterThan(0);
      for (const call of deletes) expect(call[2]).toEqual({ settings: SYNC_DELETE });
      command.mockRestore();
    });

    it('asks nothing of the tables to delete for an ID that never had a row', async () => {
      const ch = await fresh();
      await commit(ch, 10);
      const command = jest.spyOn(ch, 'command');
      const insert = jest.spyOn(ch, 'insert');
      await rebuildMptIssuances(ch, [{ id: A, holders: [H1] }], 10);
      expect(command).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(await issuancesOf(ch)).toEqual([]);
      command.mockRestore();
      insert.mockRestore();
    });

    it('deletes a pair with no state row left', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { outstanding_amount: '3' })],
        [holderState(A, H1, 10, { amount: '1' })],
      );
      await insertCommitted(ch, [], [holderState(A, H2, 11, { amount: '2' })]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 11);
      expect((await holdersOf(ch, A)).map((h) => h.holder)).toEqual([H1, H2]);
      expect((await issuanceOf(ch, A)).holders).toBe(2);

      await dropLedger(ch, 11);
      const written = await recomputeMptHolders(
        ch,
        [
          { id: A, holder: H1 },
          { id: A, holder: H2 },
        ],
        11,
      );
      // one row is written, for the pair that still has its state row, and the other pair is gone
      expect(written).toBe(1);
      expect((await holdersOf(ch, A)).map((h) => h.holder)).toEqual([H1]);
      await recomputeMptIssuances(ch, [A], 11);
      expect(await issuanceOf(ch, A)).toMatchObject({ holders: 1, last_ledger: 10 });
    });

    it('is idempotent: the same newest values under higher versions', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { outstanding_amount: '7', tx_type: 'MPTokenIssuanceCreate' })],
        [holderState(A, H1, 10, { amount: '7' })],
      );
      const stale = [{ id: A, holders: [H1] }];
      await rebuildMptIssuances(ch, stale, 10);
      const [firstIssuance, firstHolder] = [await issuanceOf(ch, A), (await holdersOf(ch, A))[0]];
      await rebuildMptIssuances(ch, stale, 10);
      const [secondIssuance, secondHolder] = [await issuanceOf(ch, A), (await holdersOf(ch, A))[0]];
      expect(without(secondIssuance)).toEqual(without(firstIssuance));
      expect(without(secondHolder)).toEqual(without(firstHolder));
      expect(BigInt(secondIssuance.version)).toBeGreaterThan(BigInt(firstIssuance.version));
      expect(BigInt(secondHolder.version)).toBeGreaterThan(BigInt(firstHolder.version));
    });

    it('is never below one more than the newest version of the key, even when the clock is behind it', async () => {
      const ch = await fresh();
      await insertCommitted(ch, [issuanceState(A, 10)], [holderState(A, H1, 10, { amount: '1' })]);
      await insertCommitted(ch, [issuanceState(B, 10, { tx_index: 1 })], [holderState(B, H1, 10, { amount: '1' })]);
      await rebuildMptIssuances(ch, [{ id: B, holders: [] }], 10);
      const clocked = BigInt((await issuanceOf(ch, B)).version);

      // versions from a clock far ahead
      const ahead = '8000000000000000';
      await ch.insert(Table.MptIssuances, [
        {
          mpt_issuance_id: A,
          issuer: ISSUER,
          sequence: 1,
          state_known: 1,
          flags: 0,
          asset_scale: 0,
          maximum_amount: null,
          outstanding_amount: '0',
          escrowed_amount: '0',
          locked_amount: '0',
          locked_holders: 0,
          holders: 0,
          transfer_fee: 0,
          metadata_hex: '',
          metadata: '',
          metadata_conforms: 0,
          ticker: '',
          name: '',
          created_ledger: null,
          created_time: null,
          created_tx_hash: null,
          last_ledger: 1,
          destroyed: 0,
          version: ahead,
        },
      ]);
      await ch.insert(Table.MptHolders, [
        {
          mpt_issuance_id: A,
          holder: H1,
          amount: '0',
          escrowed_amount: '0',
          flags: 0,
          last_ledger: 1,
          deleted: 0,
          version: ahead,
        },
      ]);

      await rebuildMptIssuances(
        ch,
        [
          { id: A, holders: [H1] },
          { id: B, holders: [] },
        ],
        10,
      );
      expect((await issuanceOf(ch, A)).version).toBe('8000000000000001');
      expect((await holdersOf(ch, A))[0]).toMatchObject({ version: '8000000000000001', amount: '1' });
      // an issuance keeps its own version: another's high one does not hold it up
      const own = BigInt((await issuanceOf(ch, B)).version);
      expect(own).toBeGreaterThan(clocked);
      expect(own).toBeLessThan(8000000000000000n);
    });

    it('writes the holders of one call under one version, each pair a new row', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [],
        [holderState(A, H1, 10, { amount: '1' }), holderState(A, H2, 10, { amount: '2' }), holderState(B, H1, 10)],
      );
      const pairs = [
        { id: A, holder: H1 },
        { id: A, holder: H2 },
        { id: B, holder: H1 },
      ];
      expect(await recomputeMptHolders(ch, pairs, 10)).toBe(3);
      expect(new Set((await holdersOf(ch)).map((h) => h.version)).size).toBe(1);
      // the same pair twice is one row
      expect(await recomputeMptHolders(ch, [...pairs, ...pairs], 10)).toBe(3);
    });

    it('reads a duplicated state row once', async () => {
      const ch = await fresh();
      await ch.command(`SYSTEM STOP MERGES ${Table.MptIssuanceStates}`);
      await ch.command(`SYSTEM STOP MERGES ${Table.MptHolderStates}`);
      await ch.command(`SYSTEM STOP MERGES ${Table.MptTouches}`);
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { outstanding_amount: '12', tx_type: 'MPTokenIssuanceCreate' })],
        [
          holderState(A, H1, 10, { amount: '5', flags: LSF_MPT_LOCKED }),
          holderState(A, H2, 10, { amount: '7', flags: LSF_MPT_LOCKED }),
        ],
      );
      // a separate insert of the same rows, past the dedup window's check: the tables hold every row twice
      for (const table of [Table.MptIssuanceStates, Table.MptHolderStates, Table.MptTouches]) {
        await ch.command(`INSERT INTO ${table} SELECT * FROM ${table}`, {}, { settings: { insert_deduplicate: 0 } });
      }
      // the premise: the copies are there, not merged and not dropped by the dedup window
      expect(await ch.query(`SELECT count() AS n FROM ${Table.MptIssuanceStates}`)).toEqual([{ n: 2 }]);
      expect(await ch.query(`SELECT count() AS n FROM ${Table.MptHolderStates}`)).toEqual([{ n: 4 }]);
      expect(await ch.query(`SELECT count() AS n FROM ${Table.MptTouches}`)).toEqual([{ n: 6 }]);

      const { issuances } = await mptIssuancesChangedSince(ch, 0, 10, MPT_STATE_BATCH);
      expect(issuances).toEqual([{ id: A, holders: [H1, H2].sort() }]);
      // each copy read would be a row written, which one insert would hide by collapsing them: so the count of rows it wrote
      expect(
        await recomputeMptHolders(
          ch,
          [
            { id: A, holder: H1 },
            { id: A, holder: H2 },
          ],
          10,
        ),
      ).toBe(2);
      expect(await recomputeMptIssuances(ch, [A], 10)).toBe(1);
      await rebuildMptIssuances(ch, issuances, 10);
      expect(await issuanceOf(ch, A)).toMatchObject({
        outstanding_amount: '12',
        holders: 2,
        locked_holders: 2,
        locked_amount: '12',
        created_ledger: 10,
      });
      expect((await holdersOf(ch, A)).map((h) => h.amount)).toEqual([H1, H2].sort().map((h) => (h === H1 ? '5' : '7')));
    });

    it('rebuilds at or below the head: the rows of a ledger being written are not read', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { outstanding_amount: '1' })],
        [holderState(A, H1, 10, { amount: '1' })],
      );
      // written, and not committed
      await insertUncommitted(
        ch,
        [issuanceState(A, 11, { outstanding_amount: '2' })],
        [holderState(A, H1, 11, { amount: '2' }), holderState(A, H2, 11, { amount: '3' })],
      );
      await rebuildMptIssuances(ch, [{ id: A, holders: [H1, H2] }], await committedHead(ch));
      expect(await issuanceOf(ch, A)).toMatchObject({ outstanding_amount: '1', holders: 1, last_ledger: 10 });
      expect(await holdersOf(ch, A)).toEqual([expect.objectContaining({ holder: H1, amount: '1', last_ledger: 10 })]);
    });

    it('writes the holders before the issuance, so that a count is never ahead of the rows it counts', async () => {
      const ch = await fresh();
      await insertCommitted(ch, [issuanceState(A, 10)], [holderState(A, H1, 10, { amount: '1' })]);
      const insert = jest.spyOn(ch, 'insert');
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 10);
      expect(insert.mock.calls.map(([table]) => table)).toEqual([Table.MptHolders, Table.MptIssuances]);
      insert.mockRestore();
    });

    it('stores the row with its keys in the pinned order', async () => {
      const ch = await fresh();
      await insertCommitted(ch, [issuanceState(A, 10)], [holderState(A, H1, 10)]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 10);
      expect(Object.keys(await issuanceOf(ch, A))).toEqual([
        'mpt_issuance_id',
        'issuer',
        'sequence',
        'state_known',
        'flags',
        'asset_scale',
        'maximum_amount',
        'outstanding_amount',
        'escrowed_amount',
        'locked_amount',
        'locked_holders',
        'holders',
        'transfer_fee',
        'metadata_hex',
        'metadata',
        'metadata_conforms',
        'ticker',
        'name',
        'created_ledger',
        'created_time',
        'created_tx_hash',
        'last_ledger',
        'destroyed',
        'version',
      ]);
    });

    describe('the abort', () => {
      /** A signal aborted as the first read of a table answers: the checks after it are what is left to stop the rebuild. */
      function abortAfterReadOf(ch: ClickHouseService, table: Table): AbortSignal {
        const aborter = new AbortController();
        const query = ch.query.bind(ch);
        jest.spyOn(ch, 'query').mockImplementation((async (sql: string, ...rest: never[]) => {
          const rows = await (query as (...a: unknown[]) => Promise<unknown>)(sql, ...rest);
          if (sql.includes(`FROM ${table}`)) aborter.abort();
          return rows;
        }) as never);
        return aborter.signal;
      }

      afterEach(() => jest.restoreAllMocks());

      it('writes nothing once the signal is aborted, before any read', async () => {
        const ch = await fresh();
        await insertCommitted(ch, [issuanceState(A, 10)], [holderState(A, H1, 10, { amount: '1' })]);
        const aborted = new AbortController();
        aborted.abort();
        const query = jest.spyOn(ch, 'query');
        const stale = [{ id: A, holders: [H1] }];
        const { signal } = aborted;
        await expect(rebuildMptIssuances(ch, stale, 10, { signal })).rejects.toBeInstanceOf(MptStateAborted);
        await expect(recomputeMptHolders(ch, [{ id: A, holder: H1 }], 10, { signal })).rejects.toBeInstanceOf(
          MptStateAborted,
        );
        await expect(recomputeMptIssuances(ch, [A], 10, { signal })).rejects.toBeInstanceOf(MptStateAborted);
        expect(query).not.toHaveBeenCalled();
      });

      it('writes no holder when it is aborted in the read before the write', async () => {
        const ch = await fresh();
        await insertCommitted(ch, [issuanceState(A, 10)], [holderState(A, H1, 10, { amount: '1' })]);
        const signal = abortAfterReadOf(ch, Table.MptHolderStates);
        const insert = jest.spyOn(ch, 'insert');
        await expect(rebuildMptIssuances(ch, [{ id: A, holders: [H1] }], 10, { signal })).rejects.toBeInstanceOf(
          MptStateAborted,
        );
        expect(insert).not.toHaveBeenCalled();
      });

      it('deletes no pair when it is aborted in the read before the delete', async () => {
        const ch = await fresh();
        await insertCommitted(ch, [issuanceState(A, 10)], [holderState(A, H1, 10, { amount: '1' })]);
        await rebuildMptIssuances(ch, [{ id: A, holders: [H1] }], 10);
        await ch.command(`DELETE FROM ${Table.MptHolderStates} WHERE 1`, {}, { settings: SYNC_DELETE });
        const signal = abortAfterReadOf(ch, Table.MptHolderStates);
        const command = jest.spyOn(ch, 'command');
        await expect(recomputeMptHolders(ch, [{ id: A, holder: H1 }], 10, { signal })).rejects.toBeInstanceOf(
          MptStateAborted,
        );
        expect(command).not.toHaveBeenCalled();
        expect(await holdersOf(ch, A)).toHaveLength(1);
      });

      it('writes no issuance when it is aborted in the read before the write: its holders are there to be done again', async () => {
        const ch = await fresh();
        await insertCommitted(ch, [issuanceState(A, 10)], [holderState(A, H1, 10, { amount: '1' })]);
        const signal = abortAfterReadOf(ch, Table.MptIssuanceStates);
        const insert = jest.spyOn(ch, 'insert');
        await expect(rebuildMptIssuances(ch, [{ id: A, holders: [H1] }], 10, { signal })).rejects.toBeInstanceOf(
          MptStateAborted,
        );
        expect(insert.mock.calls.map(([table]) => table)).toEqual([Table.MptHolders]);
        // so the touches stay stale, and the job finds them again
        expect(await mptIssuancesChangedSince(ch, 0, 10, 5)).toEqual({
          issuances: [{ id: A, holders: [H1] }],
          upTo: 10,
        });
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('what to rebuild', () => {
    it('answers the stale issuances oldest first with the holders touched since, and upTo by the four rules', async () => {
      const ch = await fresh();
      // rule 4: nothing while the head is not past the ledger
      expect(await mptIssuancesChangedSince(ch, 0, 0, 2)).toEqual({ issuances: [], upTo: 0 });
      await commit(ch, 5);
      expect(await mptIssuancesChangedSince(ch, 5, 5, 2)).toEqual({ issuances: [], upTo: 5 });
      expect(await mptIssuancesChangedSince(ch, 7, 5, 2)).toEqual({ issuances: [], upTo: 7 });

      await insertCommitted(
        ch,
        [issuanceState(B, 10), issuanceState(A, 20), issuanceState(C, 30)],
        [holderState(B, H2, 15), holderState(B, H1, 16), holderState(A, H3, 25)],
      );
      await commit(ch, 40);

      // rule 1: no more than the limit: all of them, up to the head, with the holders of each, oldest first
      expect(await mptIssuancesChangedSince(ch, 5, 40, 3)).toEqual({
        issuances: [
          { id: B, holders: [H1, H2].sort() },
          { id: A, holders: [H3] },
          { id: C, holders: [] },
        ],
        upTo: 40,
      });
      // rule 2: more than the limit: those before the first left out, up to the ledger before it
      expect(await mptIssuancesChangedSince(ch, 5, 40, 2)).toEqual({
        issuances: [
          { id: B, holders: [H1, H2].sort() },
          { id: A, holders: [H3] },
        ],
        upTo: 29,
      });
      // the range is (ledger, head]: below the cursor is not looked at, and neither is above the head
      expect(await mptIssuancesChangedSince(ch, 15, 40, 3)).toEqual({
        issuances: [
          { id: B, holders: [H1] },
          { id: A, holders: [H3] },
          { id: C, holders: [] },
        ],
        upTo: 40,
      });
      expect(await mptIssuancesChangedSince(ch, 5, 16, 3)).toEqual({
        issuances: [{ id: B, holders: [H1, H2].sort() }],
        upTo: 16,
      });
      // nothing left to the head: the cursor goes there and nothing comes back
      expect(await mptIssuancesChangedSince(ch, 30, 40, 3)).toEqual({ issuances: [], upTo: 40 });
    });

    it('answers every issuance of a ledger that holds more of them than the limit, so that it always moves on (rule 3)', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10), issuanceState(B, 10, { tx_index: 1 }), issuanceState(C, 10, { tx_index: 2 })],
        [holderState(A, H1, 10), holderState(B, H2, 10, { tx_index: 1 })],
      );
      await insertCommitted(ch, [issuanceState(A, 20, { tx_index: 0 })], [holderState(A, H3, 20)]);
      expect(await mptIssuancesChangedSince(ch, 0, 20, 2)).toEqual({
        issuances: [
          { id: A, holders: [H1] },
          { id: B, holders: [H2] },
          { id: C, holders: [] },
        ],
        upTo: 10,
      });
    });

    it('leaves out an issuance its row has seen, until it is touched above that', async () => {
      const ch = await fresh();
      await insertCommitted(ch, [issuanceState(A, 10)], [holderState(A, H1, 10)]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [H1] }], 10);
      expect(await mptIssuancesChangedSince(ch, 0, 10, 5)).toEqual({ issuances: [], upTo: 10 });

      await insertCommitted(ch, [], [holderState(A, H2, 12)]);
      expect(await mptIssuancesChangedSince(ch, 0, 12, 5)).toEqual({
        issuances: [{ id: A, holders: [H2] }],
        upTo: 12,
      });
    });

    it('does not report a touch above the head, and does not pass its ledger', async () => {
      const ch = await fresh();
      await insertCommitted(ch, [issuanceState(A, 10)]);
      await insertUncommitted(ch, [issuanceState(B, 11)], []);
      const head = await committedHead(ch);
      expect(head).toBe(10);
      expect(await mptIssuancesChangedSince(ch, 0, head, 5)).toEqual({
        issuances: [{ id: A, holders: [] }],
        upTo: 10,
      });
    });

    it('finds the watermark again after a restart', async () => {
      const ch = await fresh();
      // no ledger at all
      expect(await mptStateWatermark(ch)).toBe(0);
      // no touch
      await commit(ch, 5);
      expect(await mptStateWatermark(ch)).toBe(5);

      await insertCommitted(ch, [issuanceState(A, 10), issuanceState(B, 20)], [holderState(C, H1, 30)]);
      // nothing rebuilt: the ledger before the oldest stale touch
      expect(await mptStateWatermark(ch)).toBe(9);
      // the oldest rebuilt: the next one holds it back
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 30);
      expect(await mptStateWatermark(ch)).toBe(19);
      // a batch further on rebuilt first does not pass the older stale one
      await rebuildMptIssuances(ch, [{ id: C, holders: [H1] }], 30);
      expect(await mptStateWatermark(ch)).toBe(19);
      // all rebuilt: the head, past ledgers with no touch
      await rebuildMptIssuances(ch, [{ id: B, holders: [] }], 30);
      await commit(ch, 50);
      expect(await mptStateWatermark(ch)).toBe(50);
      // a touch above the head is not counted
      await insertUncommitted(ch, [issuanceState(A, 60)], []);
      expect(await mptStateWatermark(ch)).toBe(50);
    });

    it('finds the issuances of a dirty slice: touched in it, or last seen in it', async () => {
      const ch = await fresh();
      const rates = new RatesService(ch, 'XRP');
      const sliceOf = (from: number, to: number): [Date, Date] => [
        new Date((T0 + from) * SEC),
        new Date((T0 + to) * SEC),
      ];
      await insertCommitted(
        ch,
        [issuanceState(A, 10), issuanceState(B, 20), issuanceState(C, 40)],
        [holderState(A, H1, 11), holderState(A, H2, 21), holderState(B, H3, 21)],
      );
      // no ledger closed in it
      expect(await mptIssuancesClosedIn(ch, rates, ...sliceOf(100, 200))).toEqual([]);
      // touched in the slice: with the holders touched there, sorted, and the issuance's own node names none
      expect(await mptIssuancesClosedIn(ch, rates, ...sliceOf(10, 12))).toEqual([{ id: A, holders: [H1] }]);
      expect(await mptIssuancesClosedIn(ch, rates, ...sliceOf(20, 22))).toEqual([
        { id: A, holders: [H2] },
        { id: B, holders: [H3] },
      ]);
      // [from, to): the ledger of the second after the slice is not in it
      expect(await mptIssuancesClosedIn(ch, rates, ...sliceOf(40, 41))).toEqual([{ id: C, holders: [] }]);

      await rebuildMptIssuances(
        ch,
        [
          { id: A, holders: [] },
          { id: B, holders: [] },
          { id: C, holders: [] },
        ],
        40,
      );
      // the re-ingest of ledger 21 drops the rows of both holders there, so that no touch is left to name them or B's holder:
      // the row of the issuance last seen there names B, and the row of each holder names its pair, also the pair of A, whose
      // own row last saw another ledger
      await dropLedger(ch, 21);
      expect((await issuanceOf(ch, A)).last_ledger).toBe(21);
      expect((await issuanceOf(ch, B)).last_ledger).toBe(21);
      await insertCommitted(ch, [issuanceState(A, 41)]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 41);
      expect((await issuanceOf(ch, A)).last_ledger).toBe(41);
      expect(await mptIssuancesClosedIn(ch, rates, ...sliceOf(21, 22))).toEqual([
        { id: A, holders: [H2] },
        { id: B, holders: [H3] },
      ]);
      // a holder whose newest row says another ledger is not named
      expect(await mptIssuancesClosedIn(ch, rates, ...sliceOf(41, 42))).toEqual([{ id: A, holders: [] }]);

      // and rebuilding what the slice named leaves the pairs gone, and A's other holder as it was
      await rebuildMptIssuances(ch, await mptIssuancesClosedIn(ch, rates, ...sliceOf(21, 22)), 41);
      expect((await holdersOf(ch, A)).map((h) => h.holder)).toEqual([H1]);
      expect(await holdersOf(ch, B)).toEqual([]);
      expect((await issuanceOf(ch, A)).holders).toBe(0);
    });

    it('finds a pair of an issuance last seen elsewhere, also when the issuance was not touched in the slice at all', async () => {
      const ch = await fresh();
      const rates = new RatesService(ch, 'XRP');
      await insertCommitted(ch, [issuanceState(A, 30)], [holderState(A, H1, 10), holderState(A, H2, 20)]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 30);
      await dropLedger(ch, 10);
      const slice: [Date, Date] = [new Date((T0 + 10) * SEC), new Date((T0 + 11) * SEC)];
      expect(await mptIssuancesClosedIn(ch, rates, ...slice)).toEqual([{ id: A, holders: [H1] }]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("an issuance's last_ledger claims the pairs below it: whatever rebuilt it, they were rebuilt", () => {
    it('rebuilds a holder touched while the issuance was set aside, from a retry that holds only the ID', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { outstanding_amount: '1' })],
        [holderState(A, H1, 10, { amount: '1' })],
      );
      await rebuildMptIssuances(ch, [{ id: A, holders: [H1] }], 10);

      // the issuance fails and is set aside; the cursor goes on, past these touches, and no batch names them
      await insertCommitted(ch, [], [holderState(A, H2, 12, { amount: '2' })]);
      await insertCommitted(
        ch,
        [issuanceState(A, 14, { outstanding_amount: '6' })],
        [holderState(A, H3, 13, { amount: '3' })],
      );

      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 14);

      expect((await holdersOf(ch, A)).map((h) => [h.holder, h.amount])).toEqual(
        [
          [H1, '1'],
          [H2, '2'],
          [H3, '3'],
        ].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
      );
      expect(await issuanceOf(ch, A)).toMatchObject({ holders: 3, last_ledger: 14 });
      // and nothing is left that nobody will rebuild
      expect(await mptIssuancesChangedSince(ch, 0, 14, 5)).toEqual({ issuances: [], upTo: 14 });
    });

    it('rebuilds at a hook of a newer head the pairs the live job has not reached, not only those the slice names', async () => {
      const ch = await fresh();
      const rates = new RatesService(ch, 'XRP');
      await insertCommitted(
        ch,
        [issuanceState(A, 10, { outstanding_amount: '1' })],
        [holderState(A, H1, 10, { amount: '1' })],
      );
      await rebuildMptIssuances(ch, [{ id: A, holders: [H1] }], 10);

      // a live touch the job has read no head for yet, and a state row above it: without more, the hook's row claims it has seen
      // the live touch, which stops being stale and is never rebuilt
      await insertCommitted(ch, [], [holderState(A, H2, 12, { amount: '2' })]);
      await insertCommitted(
        ch,
        [issuanceState(A, 20, { outstanding_amount: '6' })],
        [holderState(A, H3, 20, { amount: '3' })],
      );

      // the slice of the older ledger is rewritten behind the aggregator: the hook names only what it finds there
      const named = await mptIssuancesClosedIn(ch, rates, new Date((T0 + 10) * SEC), new Date((T0 + 11) * SEC));
      expect(named).toEqual([{ id: A, holders: [H1] }]);
      await rebuildMptIssuances(ch, named, 20);

      expect((await holdersOf(ch, A)).map((h) => h.holder)).toEqual([H1, H2, H3].sort());
      expect(await issuanceOf(ch, A)).toMatchObject({ holders: 3, last_ledger: 20 });
      expect(await mptIssuancesChangedSince(ch, 10, 20, 5)).toEqual({ issuances: [], upTo: 20 });
    });

    it('rebuilds with the tie of one ledger the pairs touched above it (rule 3)', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10), issuanceState(B, 10, { tx_index: 1 })],
        [holderState(A, H1, 10, { amount: '1' })],
      );
      await insertCommitted(ch, [], [holderState(A, H2, 11, { amount: '2' })]);
      await insertCommitted(ch, [issuanceState(A, 12)]);
      const { issuances, upTo } = await mptIssuancesChangedSince(ch, 0, 12, 1);
      // the read of the tie names the holders of that ledger only
      expect(issuances).toEqual([
        { id: A, holders: [H1] },
        { id: B, holders: [] },
      ]);
      expect(upTo).toBe(10);

      await rebuildMptIssuances(ch, issuances, 12);
      expect((await holdersOf(ch, A)).map((h) => h.holder)).toEqual([H1, H2].sort());
      expect(await issuanceOf(ch, A)).toMatchObject({ holders: 2, last_ledger: 12 });
    });

    it('does not rewrite a pair its row has already seen: only those touched above it', async () => {
      const ch = await fresh();
      await insertCommitted(
        ch,
        [issuanceState(A, 10)],
        [holderState(A, H1, 10, { amount: '1' }), holderState(A, H2, 10, { amount: '2' })],
      );
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 10);
      const seen = (await holdersOf(ch, A)).find((h) => h.holder === H1)?.version;
      await insertCommitted(ch, [], [holderState(A, H2, 11, { amount: '5' })]);
      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 11);
      const after = await holdersOf(ch, A);
      expect(after.find((h) => h.holder === H1)?.version).toBe(seen);
      expect(after.find((h) => h.holder === H2)?.amount).toBe('5');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the size of a rebuild', () => {
    /** Holders of a real address's width, in the order of their names. */
    const bulkHolder = (expr: string): string => `concat('rHolder', leftPad(toString(${expr}), 27, '0'))`;
    const holderAt = (n: number): string => `rHolder${String(n).padStart(27, '0')}`;

    /** `n` holders of an issuance in one ledger, with their touches: server-side, as one insert each. */
    async function seedHolders(ch: ClickHouseService, id: string, n: number, ledger: number): Promise<void> {
      await ch.command(
        `INSERT INTO ${Table.MptHolderStates}
           (holder, mpt_issuance_id, ledger_index, tx_index, node_index, tx_hash, tx_type, close_time, amount, escrowed_amount, flags, deleted)
         SELECT ${bulkHolder('number')}, {id:String}, {ledger:UInt32}, toUInt32(number), 0, 'synthetic', 'Payment', {close:UInt32}, number + 1, 0, 0, 0
           FROM numbers({n:UInt32})`,
        { id, ledger, n, close: T0 + ledger },
      );
      await ch.command(
        `INSERT INTO ${Table.MptTouches} (ledger_index, tx_index, mpt_issuance_id, holder)
         SELECT {ledger:UInt32}, toUInt32(number), {id:String}, ${bulkHolder('number')} FROM numbers({n:UInt32})`,
        { id, ledger, n },
      );
    }

    it('keeps 5,000 holders to an insert and 2,000 pairs to a read and a delete, sorted, across each boundary', async () => {
      expect([MPT_HOLDERS_CHUNK, MPT_HOLDERS_READ_CHUNK]).toEqual([5000, 2000]);
      const ch = await fresh();
      const N = MPT_HOLDERS_CHUNK + 1;
      await seedHolders(ch, A, N, 10);
      await commit(ch, 10);
      const pairs = Array.from({ length: N }, (_, n) => ({ id: A, holder: holderAt(n) }));
      // handed in out of order, and a pair twice
      const shuffled = [...pairs.slice(2500), ...pairs.slice(0, 2500), pairs[0]];

      const query = jest.spyOn(ch, 'query');
      const insert = jest.spyOn(ch, 'insert');
      expect(await recomputeMptHolders(ch, shuffled, 10)).toBe(N);
      const reads = query.mock.calls.filter(([sql]) => sql.includes(`FROM ${Table.MptHolderStates}`));
      const named = reads.map(([, params]) => (params as { holders: string[] }).holders);
      expect(named.map((h) => h.length)).toEqual([2000, 2000, 1001]);
      expect(named.flat()).toEqual(pairs.map((p) => p.holder));
      expect(insertsInto(insert, Table.MptHolders)).toEqual([5000, 1]);
      query.mockRestore();
      insert.mockRestore();

      const stored = await holdersOf(ch, A);
      expect(stored).toHaveLength(N);
      expect(stored[N - 1]).toMatchObject({ holder: holderAt(N - 1), amount: String(N), last_ledger: 10 });
      expect(new Set(stored.map((h) => h.version)).size).toBe(1);

      // the pairs of a re-ingest that dropped more of them than one delete takes
      const gone = MPT_HOLDERS_READ_CHUNK + 1;
      await ch.command(
        `DELETE FROM ${Table.MptHolderStates} WHERE holder < {below:String}`,
        { below: holderAt(gone) },
        { settings: SYNC_DELETE },
      );
      const command = jest.spyOn(ch, 'command');
      expect(await recomputeMptHolders(ch, pairs, 10)).toBe(N - gone);
      const deletes = command.mock.calls.filter(([sql]) => sql.startsWith(`DELETE FROM ${Table.MptHolders}`));
      expect(deletes.map(([, params]) => (params as { holders: string[] }).holders.length)).toEqual([2000, 1]);
      expect(deletes.flatMap(([, params]) => (params as { holders: string[] }).holders)).toEqual(
        pairs.slice(0, gone).map((p) => p.holder),
      );
      command.mockRestore();
      expect(await holdersOf(ch, A)).toHaveLength(N - gone);
    });

    it('rebuilds an issuance of 120,000 holders', async () => {
      const ch = await fresh();
      const N = 120_000;
      await insertCommitted(ch, [issuanceState(A, 10, { outstanding_amount: String((N * (N + 1)) / 2) })]);
      await seedHolders(ch, A, N, 10);
      const insert = jest.spyOn(ch, 'insert');
      const query = jest.spyOn(ch, 'query');

      await rebuildMptIssuances(ch, [{ id: A, holders: [] }], 10);

      expect(insertsInto(insert, Table.MptHolders)).toEqual(Array(24).fill(MPT_HOLDERS_CHUNK));
      for (const [, params] of query.mock.calls) {
        const { holders } = (params ?? {}) as { holders?: string[] };
        if (holders) expect(holders.length).toBeLessThanOrEqual(MPT_HOLDERS_READ_CHUNK);
      }
      insert.mockRestore();
      query.mockRestore();
      expect(await issuanceOf(ch, A)).toMatchObject({ holders: N, last_ledger: 10 });
      expect(await ch.query(`SELECT count() AS n FROM ${Table.MptHolders}`)).toEqual([{ n: N }]);
    });

    describe('what a read costs', () => {
      const PAIRS = 50;
      const GRANULE = 8192;
      const PARTS = 4;
      const BULK_PER_PART = 100_000;
      const HEAD = 500;
      let ch: ClickHouseService;
      let db: string;
      /** The 50 pairs: adjacent in the key, with a row in each part, among the bulk of other holders on either side of them. */
      const pairName = (n: number): string => holderOf(`Pair${String(n).padStart(4, '0')}`);
      const pairs = Array.from({ length: PAIRS }, (_, n) => ({ id: A, holder: pairName(n) }));

      /** What `system.query_log` says the SELECTs on a table read while `run` ran. */
      async function readsOf(
        table: Table,
        run: () => Promise<unknown>,
      ): Promise<Array<{ query: string; read_rows: number }>> {
        const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
        await run();
        await ch.command('SYSTEM FLUSH LOGS');
        const rows = await ch.query<{ query: string; read_rows: string }>(
          `SELECT query, read_rows FROM system.query_log
            WHERE current_database = {db:String} AND type = 'QueryFinish' AND query_kind = 'Select'
              AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, {table:String})
            ORDER BY query_start_time_microseconds`,
          { db, t, table: `${db}.${table}` },
        );
        return rows.map((x) => ({ query: x.query, read_rows: Number(x.read_rows) }));
      }

      beforeAll(async () => {
        ch = await fresh();
        db = `mpt_state_job_${dbCounter}`;
        for (const table of [Table.MptHolderStates, Table.MptTouches, Table.MptHolders]) {
          await ch.command(`SYSTEM STOP MERGES ${table}`);
        }
        for (let part = 0; part < PARTS; part++) {
          // one part: the pairs, a row each, among other holders of the issuance, half sorted before them and half after them
          await ch.command(
            `INSERT INTO ${Table.MptHolderStates}
               (holder, mpt_issuance_id, ledger_index, tx_index, node_index, tx_hash, tx_type, close_time, amount, escrowed_amount, flags, deleted)
             SELECT if(number < {pairs:UInt32},
                       concat('rPair', leftPad(toString(number), 4, '0'), repeat('0', 25)),
                       concat(if(number % 2 = 0, 'rAbove', 'rZulu'), leftPad(toString(number), 28, '0'))),
                    {id:String}, toUInt32(100 + {part:UInt32}), toUInt32(number), 0, 'synthetic', 'Payment', {close:UInt32},
                    if(number < {pairs:UInt32}, {part:UInt32} + 1, 1), 0, 0, 0
               FROM numbers({rows:UInt32})`,
            { id: A, part, pairs: PAIRS, rows: BULK_PER_PART + PAIRS, close: T0 + 100 },
            { settings: { insert_deduplicate: 0 } },
          );
          // and the touches of a part, of another issuance, below what the row of this one will have seen
          await ch.command(
            `INSERT INTO ${Table.MptTouches} (ledger_index, tx_index, mpt_issuance_id, holder)
             SELECT toUInt32(100 + {part:UInt32}), toUInt32(number), {id:String}, concat('rAbove', leftPad(toString(number), 28, '0'))
               FROM numbers({rows:UInt32})`,
            { id: B, part, rows: BULK_PER_PART },
            { settings: { insert_deduplicate: 0 } },
          );
        }
        await ch.insert(Table.MptIssuanceStates, [issuanceState(A, HEAD)]);
        await ch.insert(Table.MptTouches, [{ ledger_index: HEAD, tx_index: 0, mpt_issuance_id: A, holder: '' }]);
        await commit(ch, HEAD);
      });

      it('the world is what the bound is against: more than one part, each many times the bound', async () => {
        const parts = await ch.query<{ rows: string }>(
          `SELECT rows FROM system.parts WHERE database = {db:String} AND table = {table:String} AND active`,
          { db, table: Table.MptHolderStates },
        );
        expect(parts.length).toBeGreaterThanOrEqual(PARTS);
        expect(await ch.query(`SELECT count() AS n FROM ${Table.MptHolderStates}`)).toEqual([
          { n: PARTS * (BULK_PER_PART + PAIRS) },
        ]);
      });

      it('reads about 50 pairs at their rows and two granules a part, and answers their newest rows', async () => {
        const reads = await readsOf(Table.MptHolderStates, () => recomputeMptHolders(ch, pairs, HEAD));
        expect(reads).toHaveLength(1);
        expect(reads[0].read_rows).toBeLessThanOrEqual(PAIRS * PARTS + 2 * GRANULE * PARTS);
        expect((await holdersOf(ch, A)).map((h) => h.amount)).toEqual(Array(PAIRS).fill(String(PARTS)));
      });

      it('the control: a read of the holders of the issuance by its ID reads the bulk, so that the bound can fail', async () => {
        const reads = await readsOf(Table.MptHolderStates, () =>
          ch.query(
            `SELECT holder FROM ${Table.MptHolderStates} WHERE mpt_issuance_id = {id:String} AND ledger_index <= {head:UInt32}
              ORDER BY holder, mpt_issuance_id, ledger_index DESC LIMIT 1 BY holder, mpt_issuance_id`,
            { id: A, head: HEAD },
          ),
        );
        expect(reads[0].read_rows).toBeGreaterThan(PARTS * BULK_PER_PART);
      });

      it('reads the touches of a rebuild from what the row has seen: from the start only for an issuance with no row', async () => {
        const first = await readsOf(Table.MptTouches, () =>
          rebuildMptIssuances(ch, [{ id: A, holders: pairs.map((p) => p.holder) }], HEAD),
        );
        expect(first).toHaveLength(1);
        expect(first[0].read_rows).toBeGreaterThanOrEqual(PARTS * BULK_PER_PART);
        expect((await issuanceOf(ch, A)).last_ledger).toBe(HEAD);

        const newer = HEAD + 1;
        await ch.insert(Table.MptHolderStates, [holderState(A, pairs[0].holder, newer, { amount: '9' })]);
        await ch.insert(Table.MptTouches, [
          { ledger_index: newer, tx_index: 0, mpt_issuance_id: A, holder: pairs[0].holder },
        ]);
        await commit(ch, newer);
        const reads = await readsOf(Table.MptTouches, () => rebuildMptIssuances(ch, [{ id: A, holders: [] }], newer));
        expect(reads).toHaveLength(1);
        expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE * PARTS);
        expect((await holdersOf(ch, A)).find((h) => h.holder === pairs[0].holder)?.amount).toBe('9');
      });
    });
  });
});
