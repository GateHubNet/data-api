import { join } from 'node:path';
import {
  Escrowed,
  ESCROWS_CHUNK,
  EscrowsAborted,
  escrowsOfLedgers,
  EscrowsStep,
  escrowsTouchedIn,
  readEscrowed,
  recomputeEscrows,
  refreshEscrowsTotal,
  runEscrowsStep,
} from '../src/aggregate/escrows.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { EscrowsRow, ObjectChangesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { escrowId } from '../src/util/keylets';
import { mptIssuerOf } from '../src/util/mpt';
import { stableStringify } from '../src/util/stable-json';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The `escrows` job on a real ClickHouse.
 *
 * Part 1 runs the job over the recorded XRPL ledgers (`fixtures/xrpl/objects`, written through the real `LedgerWriter`) and
 * escrows made by hand (their transactions are `synthetic-…`: the cases the recordings lack: a ticketed escrow, a Hook-emitted
 * one, an MPT escrow, a finish whose creation is not indexed, an escrow made in an earlier step than the one that ends it). It
 * compares the total with a recount in SQL written another way, step by step. Part 2 moves the watermark ten ledgers at a time
 * and fails a step. Part 3 is the re-ingests. Part 4 pins what `escrowsTouchedIn` reads, over a bulk of rows of other objects.
 * Part 5 is Xahau.
 */

const T0 = 1_700_000_000;
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;

const xrplCtx = parseContextFor(getNetworkProfile('xrpl'));
const xahauCtx = parseContextFor(getNetworkProfile('xahau'));
const XRPL_LEDGERS = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/objects')).list();
const XAHAU_LEDGERS = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xahau/objects')).list();
const XRPL_CHANGES: ObjectChangesRow[] = XRPL_LEDGERS.flatMap((raw) => buildLedgerRows(raw, xrplCtx).objectChanges);

const idOf = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');
const ALICE = 'rSyntheticAlice';
const BOB = 'rSyntheticBob';
const MPT_ID = '0000012AB5F762798A53D543A014CAF8B297CFF8F2F937E8';

// Recorded (test/fixtures/xrpl/objects/manifest.json): a native timed escrow made in ledger 107897249, and the issued-token
// escrow made in 107945438 and finished in 107967068.
const TIMED_OWNER = 'rNeJW71pMjKy42j5jn7vnWZAbmuU6SKs6V';
const TIMED_SEQUENCE = 107_896_555;
const TIMED = escrowId(TIMED_OWNER, TIMED_SEQUENCE);
const TOKEN_OWNER = 'rfd4xkXuigdGJV2XYkbosFzBQaLsc6M8Vm';
const TOKEN_ESCROW = 'FA8631A0';
const RECORDED_HEAD = 107_972_102;
const RECORDED_FIRST = 102_145_584;

type Json = Record<string, unknown>;

/** An `object_changes` row of an escrow made by hand. */
function change(o: {
  id: string;
  ledger: number;
  tx?: number;
  action: 'created' | 'modified' | 'deleted';
  event: string;
  fields: Json;
  facts?: Json;
}): ObjectChangesRow {
  const tx_index = o.tx ?? 0;
  return {
    object_type: 'Escrow',
    object_id: o.id,
    ledger_index: o.ledger,
    tx_index,
    tx_hash: `synthetic-${o.ledger}-${tx_index}`,
    close_time: T0 + o.ledger,
    tx_type: o.action === 'created' ? 'EscrowCreate' : 'EscrowFinish',
    result: 'tesSUCCESS',
    sender: ALICE,
    delegate: '',
    action: o.action,
    event: o.event,
    owner: String(o.fields.Account ?? ''),
    counterparty: String(o.fields.Destination ?? ''),
    fields: stableStringify(o.fields),
    previous: '{}',
    event_fields: stableStringify(o.facts ?? {}),
  };
}

const nativeFields = (drops: number, extra: Json = {}): Json => ({
  Account: ALICE,
  Destination: BOB,
  Amount: String(drops),
  Flags: 0,
  ...extra,
});

const create = (id: string, ledger: number, fields: Json, facts: Json = {}, tx = 0): ObjectChangesRow =>
  change({ id, ledger, tx, action: 'created', event: 'create', fields, facts });
const finish = (id: string, ledger: number, fields: Json, tx = 0): ObjectChangesRow =>
  change({ id, ledger, tx, action: 'deleted', event: 'finish', fields });

/** A `ledgers` row: just enough to commit the ledger (the marker the writer writes after the rows of a ledger). */
const ledgerRow = (ledger_index: number) => ({
  ledger_index,
  ledger_hash: `${ledger_index}`.padStart(64, 'C'),
  close_time: T0 + ledger_index,
});

/** A sentinel row written by hand (the columns of the sentinel: every other one is empty, 0 or null). */
const sentinelOf = (
  over: Pick<EscrowsRow, 'amount_drops' | 'open_count' | 'through_ledger' | 'version'>,
): EscrowsRow => ({
  escrow_id: '',
  owner: '',
  destination: '',
  sequence: null,
  currency: '',
  issuer: '',
  amount: '',
  finish_after: null,
  cancel_after: null,
  has_condition: 0,
  created_ledger: null,
  last_ledger: 0,
  deleted: 0,
  ...over,
});

/** The row of `escrows` as the tests read it: the newest version of an escrow, times in unix seconds, no `UInt64` strings. */
interface StoredEscrow {
  escrow_id: string;
  owner: string;
  destination: string;
  sequence: number | null;
  currency: string;
  issuer: string;
  amount: string;
  amount_drops: string;
  finish_after: number | null;
  cancel_after: number | null;
  has_condition: number;
  created_ledger: number | null;
  last_ledger: number;
  deleted: number;
  version: number;
}

const STORED_COLUMNS = `escrow_id, owner, destination, sequence, currency, issuer, amount, toString(amount_drops) AS drops_text,
       toUnixTimestamp(finish_after) AS finish_unix, toUnixTimestamp(cancel_after) AS cancel_unix, has_condition,
       created_ledger, last_ledger, deleted, toUInt64(version) AS version_n`;

interface StoredRow extends Omit<StoredEscrow, 'amount_drops' | 'finish_after' | 'cancel_after' | 'version'> {
  drops_text: string;
  finish_unix: number | null;
  cancel_unix: number | null;
  version_n: string | number;
}

const storedOf = ({ drops_text, finish_unix, cancel_unix, version_n, ...row }: StoredRow): StoredEscrow => ({
  ...row,
  amount_drops: drops_text,
  finish_after: finish_unix,
  cancel_after: cancel_unix,
  version: Number(version_n),
});

/** What a reader sees: the newest version of each escrow, without FINAL (the sentinel is not an escrow). */
async function latestEscrows(ch: ClickHouseService): Promise<Map<string, StoredEscrow>> {
  const rows = await ch.query<StoredRow>(
    `SELECT ${STORED_COLUMNS} FROM ${Table.Escrows} WHERE escrow_id != '' ORDER BY escrow_id, version DESC LIMIT 1 BY escrow_id`,
  );
  return new Map(rows.map((r) => [r.escrow_id, storedOf(r)]));
}

/** The raw rows of the sentinel, oldest first. */
async function sentinelRows(ch: ClickHouseService) {
  const rows = await ch.query<{ drops: string; open_count: string; through_ledger: number; version_n: string }>(
    `SELECT toString(amount_drops) AS drops, open_count, through_ledger, toUInt64(version) AS version_n
       FROM ${Table.Escrows} WHERE escrow_id = '' ORDER BY version ASC`,
  );
  return rows.map((r) => ({
    drops: r.drops,
    open: Number(r.open_count),
    through_ledger: Number(r.through_ledger),
    version: Number(r.version_n),
  }));
}

/**
 * The recount: the open native escrows at a ledger, from the newest `object_changes` row of each escrow, written another way
 * than the job's (an `argMax` over a group, the amount read from the JSON of the fields, not the job's `escrows` rows).
 */
const RECOUNT_SQL = `SELECT count() AS open, toString(sum(native_drops)) AS drops
  FROM (
       SELECT argMax(action, (ledger_index, tx_index)) AS last_action,
              argMax(fields, (ledger_index, tx_index)) AS last_fields,
              JSONType(last_fields, 'Amount') = 'String' AS is_native,
              if(is_native, toUInt64OrZero(JSONExtractString(last_fields, 'Amount')), 0) AS native_drops
         FROM ${Table.ObjectChanges}
        WHERE object_type = 'Escrow' AND ledger_index <= {to:UInt32}
        GROUP BY object_id
       )
 WHERE last_action != 'deleted' AND is_native`;

async function recount(ch: ClickHouseService, to: number): Promise<{ drops: string; open: number }> {
  const [row] = await ch.query<{ open: string; drops: string }>(RECOUNT_SQL, { to });
  return { drops: row.drops, open: Number(row.open) };
}

/** Runs steps until one reaches the head; the steps are returned. */
async function runToHead(ch: ClickHouseService, native: string, step?: number): Promise<EscrowsStep[]> {
  const steps: EscrowsStep[] = [];
  for (;;) {
    const done = await runEscrowsStep(ch, { native, step });
    steps.push(done);
    if (done.to >= done.head) return steps;
    if (steps.length > 200) throw new Error('the job does not reach the head');
  }
}

describe('the escrows job (e2e)', () => {
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
    const config = { ...container.config, database: `escrows_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** Stops the merges of a table of the database of `ch`, so that rows written twice stay twice. */
  async function stopMerges(ch: ClickHouseService, table: Table): Promise<void> {
    const db = await ch.queryOne<{ db: string }>('SELECT currentDatabase() AS db');
    await ch.command(`SYSTEM STOP MERGES ${db?.db}.${table}`);
  }

  /** Rows of `object_changes` made by hand, and the `ledgers` row of every ledger of them (the commit marker). */
  async function insertChanges(ch: ClickHouseService, rows: ObjectChangesRow[], commit = true): Promise<void> {
    await ch.insert(Table.ObjectChanges, rows);
    if (commit)
      await commitLedgers(
        ch,
        rows.map((r) => r.ledger_index),
      );
  }

  const commitLedgers = (ch: ClickHouseService, ledgers: number[]): Promise<void> =>
    ch.insert(Table.Ledgers, [...new Set(ledgers)].map(ledgerRow));

  // -------------------------------------------------------------------------------------------------------------------
  describe('the recorded XRPL ledgers and escrows made by hand, in steps of 2,000,000 ledgers', () => {
    // Made by hand. Ledgers are between the recorded ones, and each has a `ledgers` row.
    const EARLY = idOf(0xe1); // made in the first step (ledger 102,500,000), finished in the last one
    const OPEN = idOf(0xe2); // native, open
    const TICKET = idOf(0xe3); // native, open: made with a ticket, so the object has no Sequence
    const HOOK = idOf(0xe4); // native, open: Hook-emitted, no sequence anywhere
    const MPT = idOf(0xe5); // an MPT escrow, open
    const ORPHAN = idOf(0xe6); // finished, its creation is not indexed
    const SHORT = idOf(0xe7); // made and finished, both in the last step
    const SYNTHETIC: ObjectChangesRow[] = [
      create(EARLY, 102_500_000, nativeFields(2_000_000, { Sequence: 11 }), { sequence: 11 }),
      finish(EARLY, 107_950_000, nativeFields(2_000_000, { Sequence: 11 })),
      create(OPEN, 107_900_000, nativeFields(12_000_000, { Sequence: 12, FinishAfter: 846_000_000 }), { sequence: 12 }),
      create(TICKET, 107_902_000, nativeFields(5_000_000, { CancelAfter: 846_100_000 }), { sequence: 77 }),
      create(HOOK, 107_903_000, nativeFields(3_000_000)),
      create(
        MPT,
        107_904_000,
        {
          Account: ALICE,
          Destination: BOB,
          Amount: { mpt_issuance_id: MPT_ID.toLowerCase(), value: '500' },
          Sequence: 13,
        },
        { sequence: 13 },
      ),
      finish(ORPHAN, 107_905_000, nativeFields(1_000_000)),
      create(SHORT, 107_960_000, nativeFields(7_000_000, { Sequence: 14 }), { sequence: 14 }),
      finish(SHORT, 107_961_000, nativeFields(7_000_000, { Sequence: 14 })),
    ];
    const OPEN_NATIVE = [OPEN, TICKET, HOOK];
    // the drops and the number of open native escrows once everything is read: the recorded timed escrow (0.5 XRP) and these
    const FINAL = { open: 1 + OPEN_NATIVE.length, drops: String(500_000 + 12_000_000 + 5_000_000 + 3_000_000) };

    let ch: ClickHouseService;
    let before: Escrowed | undefined;
    let steps: EscrowsStep[];
    let recounts: Array<{ drops: string; open: number }>;
    let escrows: Map<string, StoredEscrow>;

    beforeAll(async () => {
      ch = await fresh();
      // the rows written twice stay twice, so that the rewrites can be counted
      await stopMerges(ch, Table.Escrows);
      await new LedgerWriter(ch, xrplCtx).write(XRPL_LEDGERS);
      await insertChanges(ch, SYNTHETIC);
      before = await readEscrowed(ch);
      steps = [];
      recounts = [];
      for (;;) {
        const done = await runEscrowsStep(ch, { native: 'XRP', step: 2_000_000 });
        steps.push(done);
        recounts.push(await recount(ch, done.to));
        if (done.to >= done.head) break;
      }
      escrows = await latestEscrows(ch);
    });

    it('readEscrowed is undefined before the first run', () => {
      expect(before).toBeUndefined();
    });

    it('starts at the ledger before the first committed one and moves a step at a time to the head', () => {
      expect(steps.map((s) => [s.from, s.to, s.head])).toEqual([
        [RECORDED_FIRST - 1, RECORDED_FIRST - 1 + 2_000_000, RECORDED_HEAD],
        [RECORDED_FIRST - 1 + 2_000_000, RECORDED_FIRST - 1 + 4_000_000, RECORDED_HEAD],
        // the next step would pass the head: it stops there
        [RECORDED_FIRST - 1 + 4_000_000, RECORDED_HEAD, RECORDED_HEAD],
      ]);
    });

    it('keeps the total equal to a full recount of open native escrows, after every step', async () => {
      for (const [i, done] of steps.entries()) {
        expect([i, done.escrowed]).toEqual([i, { ...recounts[i], through_ledger: done.to }]);
      }
      // the recount sees the escrows made in the first step, and the end of one in the last
      expect(recounts[0]).toEqual({ open: 1, drops: '2000000' });
      expect(recounts[recounts.length - 1]).toEqual(FINAL);
      // the sentinel in the table is the last step's
      expect(await readEscrowed(ch)).toEqual(steps[steps.length - 1].escrowed);
      expect(steps[steps.length - 1].escrowed).toEqual({ ...FINAL, through_ledger: RECORDED_HEAD });
    });

    it('counts native escrows only', async () => {
      const all = [...escrows.values()];
      const tokens = all.filter((e) => e.issuer !== '');
      const openTokens = tokens.filter((e) => e.deleted === 0);
      const openNative = all.filter((e) => e.deleted === 0 && e.issuer === '');
      // the recordings and the MPT escrow made by hand: open token escrows, none of them with drops or in the total
      expect(openTokens.length).toBeGreaterThan(0);
      expect(tokens.every((e) => e.amount_drops === '0')).toBe(true);
      expect(openNative).toHaveLength(FINAL.open);
      expect(steps[steps.length - 1].escrowed.open).toBe(openNative.length);
      expect(steps[steps.length - 1].escrowed.open).toBeLessThan(openNative.length + openTokens.length);
      expect(escrows.get(MPT)).toMatchObject({
        currency: MPT_ID,
        issuer: mptIssuerOf(MPT_ID),
        amount: '500',
        amount_drops: '0',
        deleted: 0,
        sequence: 13,
      });
      // the recorded token escrow, made in one ledger and finished in another, is deleted
      const finished = all.find((e) => e.escrow_id.startsWith(TOKEN_ESCROW));
      expect(finished).toMatchObject({
        owner: TOKEN_OWNER,
        issuer: 'rD9ixf7RRUKuKVFTsZa3fZGAN6HtNziPKa',
        amount: '75000',
        amount_drops: '0',
        created_ledger: 107_945_438,
        last_ledger: 107_967_068,
        deleted: 1,
      });
    });

    it('writes the escrows the recordings and the cases made by hand describe', () => {
      expect(escrows.get(TIMED)).toEqual({
        escrow_id: TIMED,
        owner: TIMED_OWNER,
        destination: 'rGtW2dWHmHQ3f65pfbjYF5PbFbdZwgwuqW',
        sequence: TIMED_SEQUENCE,
        currency: 'XRP',
        issuer: '',
        amount: '0.5',
        amount_drops: '500000',
        finish_after: 846_262_201 + 946_684_800,
        cancel_after: 846_265_741 + 946_684_800,
        has_condition: 0,
        created_ledger: 107_897_249,
        last_ledger: 107_897_249,
        deleted: 0,
        version: expect.any(Number),
      });
      expect(escrows.get(TICKET)).toMatchObject({
        sequence: 77,
        deleted: 0,
        has_condition: 0,
        cancel_after: 846_100_000 + 946_684_800,
      });
      expect(escrows.get(HOOK)).toMatchObject({ sequence: null, created_ledger: 107_903_000, amount: '3' });
      expect(escrows.get(ORPHAN)).toMatchObject({
        created_ledger: null,
        last_ledger: 107_905_000,
        deleted: 1,
        sequence: null,
      });
      expect(escrows.get(SHORT)).toMatchObject({ created_ledger: 107_960_000, last_ledger: 107_961_000, deleted: 1 });
      // made in the first step, finished in the last: one row, the end of it
      expect(escrows.get(EARLY)).toMatchObject({
        created_ledger: 102_500_000,
        last_ledger: 107_950_000,
        deleted: 1,
        sequence: 11,
      });
      // a conditional token escrow of the recordings
      expect([...escrows.values()].some((e) => e.has_condition === 1 && e.issuer !== '')).toBe(true);
    });

    it('has one row per escrow with an object_changes row, each the newest and the created one', async () => {
      const rows = await ch.query<{
        object_id: string;
        ledger_index: number;
        action: string;
        fields: string;
        event_fields: string;
      }>(
        `SELECT object_id, ledger_index, action, fields, event_fields FROM ${Table.ObjectChanges}
          WHERE object_type = 'Escrow' ORDER BY object_id, ledger_index, tx_index`,
      );
      const byId = new Map<string, typeof rows>();
      for (const r of rows) byId.set(r.object_id, [...(byId.get(r.object_id) ?? []), r]);
      expect([...escrows.keys()].sort()).toEqual([...byId.keys()].sort());
      expect(byId.size).toBeGreaterThan(100);
      for (const [id, list] of byId) {
        const newest = list[list.length - 1];
        const created = list.find((r) => r.action === 'created');
        const fields = JSON.parse(newest.fields) as Json;
        expect([id, escrows.get(id)]).toEqual([
          id,
          expect.objectContaining({
            owner: fields.Account,
            destination: fields.Destination,
            last_ledger: newest.ledger_index,
            created_ledger: created?.ledger_index ?? null,
            deleted: newest.action === 'deleted' ? 1 : 0,
          }),
        ]);
      }
    });

    it('writes the sentinel on a run with nothing to do', async () => {
      const escrowRows = async (): Promise<number> =>
        Number(
          (await ch.queryOne<{ n: string }>(`SELECT count() AS n FROM ${Table.Escrows} WHERE escrow_id != ''`))?.n,
        );
      const rowsBefore = await escrowRows();
      const sentinelsBefore = await sentinelRows(ch);
      const done = await runEscrowsStep(ch, { native: 'XRP', step: 2_000_000 });
      expect(done).toMatchObject({ from: RECORDED_HEAD, to: RECORDED_HEAD, touched: 0, written: 0, removed: 0 });
      expect(done.escrowed).toEqual({ ...FINAL, through_ledger: RECORDED_HEAD });
      const sentinelsAfter = await sentinelRows(ch);
      expect(sentinelsAfter).toHaveLength(sentinelsBefore.length + 1);
      const [previous, written] = sentinelsAfter.slice(-2);
      expect(written.version).toBeGreaterThan(previous.version);
      expect({ ...written, version: 0 }).toEqual({ ...previous, version: 0 });
      expect(await escrowRows()).toBe(rowsBefore);
    });

    it('moves the sentinel on with the head when no escrow changed', async () => {
      await commitLedgers(ch, [RECORDED_HEAD + 5, RECORDED_HEAD + 6]);
      const done = await runEscrowsStep(ch, { native: 'XRP' });
      expect(done).toMatchObject({
        from: RECORDED_HEAD,
        to: RECORDED_HEAD + 6,
        head: RECORDED_HEAD + 6,
        touched: 0,
        written: 0,
      });
      expect(await readEscrowed(ch)).toEqual({ ...FINAL, through_ledger: RECORDED_HEAD + 6 });
    });

    it('is idempotent', async () => {
      const ids = (
        await ch.query<{ object_id: string }>(
          `SELECT DISTINCT object_id FROM ${Table.ObjectChanges} WHERE object_type = 'Escrow' ORDER BY object_id`,
        )
      ).map((r) => r.object_id);
      const sentinel = await readEscrowed(ch);
      const newest = async () => [...(await latestEscrows(ch)).values()];
      const first = await newest();
      const run = () => recomputeEscrows(ch, ids, { upTo: RECORDED_HEAD + 6, native: 'XRP' });
      expect(await run()).toEqual({ written: ids.length, removed: 0 });
      const second = await newest();
      expect(await run()).toEqual({ written: ids.length, removed: 0 });
      const third = await newest();
      const withoutVersion = (rows: StoredEscrow[]) => rows.map(({ version: _version, ...row }) => row);
      expect(withoutVersion(second)).toEqual(withoutVersion(first));
      expect(withoutVersion(third)).toEqual(withoutVersion(first));
      // each run is newer than the one before, and the sentinel is not touched by a recompute
      second.forEach((row, i) => expect(row.version).toBeGreaterThan(first[i].version));
      third.forEach((row, i) => expect(row.version).toBeGreaterThan(second[i].version));
      expect(await readEscrowed(ch)).toEqual(sentinel);
      expect(ids.length).toBeGreaterThan(ESCROWS_CHUNK / 10);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the watermark, ten ledgers a step', () => {
    const A = idOf(0xa1);
    const B = idOf(0xa2);
    const C = idOf(0xa3);
    const FIRST = 5000;
    const HEAD = 5025;
    let ch: ClickHouseService;

    beforeAll(async () => {
      ch = await fresh();
      await commitLedgers(
        ch,
        Array.from({ length: HEAD - FIRST + 1 }, (_, i) => FIRST + i),
      );
      await ch.insert(Table.ObjectChanges, [
        create(A, 5003, nativeFields(1_000_000, { Sequence: 1 }), { sequence: 1 }),
        create(B, 5012, nativeFields(2_000_000, { Sequence: 2 }), { sequence: 2 }),
        finish(A, 5014, nativeFields(1_000_000, { Sequence: 1 })),
        create(C, 5025, nativeFields(4_000_000, { Sequence: 3 }), { sequence: 3 }),
      ]);
    });

    it('moves the watermark a step at a time and reaches the head', async () => {
      const expected = [
        // from (the ledger before the first committed one), to = min(H, W + 10), the escrows touched, the total
        { from: 4999, to: 5009, touched: [A], escrowed: { drops: '1000000', open: 1 } },
        { from: 5009, to: 5019, touched: [A, B], escrowed: { drops: '2000000', open: 1 } },
        { from: 5019, to: 5025, touched: [C], escrowed: { drops: '6000000', open: 2 } },
        { from: 5025, to: 5025, touched: [], escrowed: { drops: '6000000', open: 2 } },
      ];
      for (const want of expected) {
        const done = await runEscrowsStep(ch, { native: 'XRP', step: 10 });
        expect(done).toMatchObject({
          from: want.from,
          to: want.to,
          head: HEAD,
          touched: want.touched.length,
          escrowed: { ...want.escrowed, through_ledger: want.to },
        });
        expect(await readEscrowed(ch)).toEqual({ ...want.escrowed, through_ledger: want.to });
      }
      expect((await latestEscrows(ch)).get(A)).toMatchObject({ deleted: 1, last_ledger: 5014, created_ledger: 5003 });
    });

    it('follows a head that moves on, and never goes back', async () => {
      await commitLedgers(ch, [5026]);
      expect(await runEscrowsStep(ch, { native: 'XRP', step: 10 })).toMatchObject({ from: 5025, to: 5026 });
      // a watermark above the head (rows were removed behind it) stays where it is
      await ch.insert(Table.Escrows, [
        sentinelOf({ amount_drops: '6000000', open_count: 2, through_ledger: 9000, version: Date.now() + 60_000 }),
      ]);
      expect(await runEscrowsStep(ch, { native: 'XRP', step: 10 })).toMatchObject({ from: 9000, to: 9000, head: 5026 });
      expect(await readEscrowed(ch)).toEqual({ drops: '6000000', open: 2, through_ledger: 9000 });
    });

    it('reads the escrows of (from, to] and of [min, max]', async () => {
      expect(await escrowsTouchedIn(ch, 5003, 5012)).toEqual([B]);
      expect(await escrowsTouchedIn(ch, 5002, 5012)).toEqual([A, B].sort());
      expect(await escrowsTouchedIn(ch, 5012, 5012)).toEqual([]);
      expect(await escrowsTouchedIn(ch, 0, 4999)).toEqual([]);
      expect(await escrowsOfLedgers(ch, 5012, 5012)).toEqual([B]);
      expect(await escrowsOfLedgers(ch, 5003, 5003)).toEqual([A]);
      expect(await escrowsOfLedgers(ch, 5013, 5013)).toEqual([]);
      expect(await escrowsOfLedgers(ch, 5014, 5003)).toEqual([]);
    });
  });

  describe('a step that fails, and one that is stopped', () => {
    const GOOD = idOf(0xb1);
    const BAD = idOf(0xb2);
    let ch: ClickHouseService;

    beforeAll(async () => {
      ch = await fresh();
      await commitLedgers(ch, [100, 101, 102, 103, 104]);
      await ch.insert(Table.ObjectChanges, [
        create(GOOD, 101, nativeFields(1_000_000, { Sequence: 1 }), { sequence: 1 }),
      ]);
    });

    it('leaves the old sentinel when the recompute fails, and does the window again at the next run', async () => {
      expect(await runEscrowsStep(ch, { native: 'XRP', step: 2 })).toMatchObject({ from: 99, to: 101 });
      const sentinel = await readEscrowed(ch);
      expect(sentinel).toEqual({ drops: '1000000', open: 1, through_ledger: 101 });
      // an Amount of a shape the ledger does not have, with a good escrow beside it
      await ch.insert(Table.ObjectChanges, [
        create(BAD, 102, { Account: ALICE, Destination: BOB, Amount: { value: '1' } }),
        create(idOf(0xb3), 103, nativeFields(2_000_000, { Sequence: 3 }), { sequence: 3 }),
      ]);
      await expect(runEscrowsStep(ch, { native: 'XRP', step: 3 })).rejects.toThrow(BAD);
      expect(await readEscrowed(ch)).toEqual(sentinel);
      await ch.command(
        `DELETE FROM ${Table.ObjectChanges} WHERE object_id = {id:String}`,
        { id: BAD },
        { settings: SYNC_DELETE },
      );
      // the window (101, 104] is done again from the old watermark
      expect(await runEscrowsStep(ch, { native: 'XRP', step: 3 })).toMatchObject({ from: 101, to: 104, written: 1 });
      expect(await readEscrowed(ch)).toEqual({ drops: '3000000', open: 2, through_ledger: 104 });
    });

    it('writes nothing once stopped', async () => {
      const count = async (): Promise<number> =>
        Number((await ch.queryOne<{ n: string }>(`SELECT count() AS n FROM ${Table.Escrows}`))?.n);
      const rows = await count();
      const stop = new AbortController();
      stop.abort();
      await expect(runEscrowsStep(ch, { native: 'XRP', signal: stop.signal })).rejects.toBeInstanceOf(EscrowsAborted);
      await expect(
        recomputeEscrows(ch, [GOOD], { upTo: 104, native: 'XRP', signal: stop.signal }),
      ).rejects.toBeInstanceOf(EscrowsAborted);
      await expect(refreshEscrowsTotal(ch, { native: 'XRP', signal: stop.signal })).rejects.toBeInstanceOf(
        EscrowsAborted,
      );
      expect(await count()).toBe(rows);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a re-ingest that removes rows', () => {
    const KEPT = idOf(0xc1);
    const VANISHED = idOf(0xc2); // all its rows are removed
    const REOPENED = idOf(0xc3); // the row that finished it is removed
    let ch: ClickHouseService;

    beforeAll(async () => {
      ch = await fresh();
      await insertChanges(ch, [
        create(KEPT, 200, nativeFields(1_000_000, { Sequence: 1 }), { sequence: 1 }),
        create(VANISHED, 210, nativeFields(4_000_000, { Sequence: 2 }), { sequence: 2 }),
        create(REOPENED, 220, nativeFields(8_000_000, { Sequence: 3 }), { sequence: 3 }),
        finish(REOPENED, 240, nativeFields(8_000_000, { Sequence: 3 })),
        // a ledger with nothing of escrows, so that the head is above all of them
      ]);
      await commitLedgers(ch, [250]);
      await runToHead(ch, 'XRP');
    });

    it('starts with the three escrows, two of them open', async () => {
      expect(await readEscrowed(ch)).toEqual({ drops: '5000000', open: 2, through_ledger: 250 });
      expect([...(await latestEscrows(ch)).keys()].sort()).toEqual([KEPT, VANISHED, REOPENED].sort());
    });

    it('deletes an escrow whose rows a re-ingest removed', async () => {
      const sentinel = (await sentinelRows(ch)).pop();
      await ch.command(
        `DELETE FROM ${Table.ObjectChanges} WHERE object_id = {id:String}`,
        { id: VANISHED },
        { settings: SYNC_DELETE },
      );
      // no row names it any more: it is found by the ledger its newest escrows row saw
      expect(await escrowsOfLedgers(ch, 205, 215)).toEqual([VANISHED]);
      expect(await recomputeEscrows(ch, [VANISHED], { upTo: 250, native: 'XRP' })).toEqual({ written: 0, removed: 1 });
      expect((await latestEscrows(ch)).has(VANISHED)).toBe(false);
      expect(
        Number(
          (
            await ch.queryOne<{ n: string }>(
              `SELECT count() AS n FROM ${Table.Escrows} WHERE escrow_id = {id:String}`,
              { id: VANISHED },
            )
          )?.n,
        ),
      ).toBe(0);
      // the total is the old one until it is read again, and then it is lower, at the same ledger, under a newer version
      expect(await readEscrowed(ch)).toEqual({ drops: '5000000', open: 2, through_ledger: 250 });
      expect(await refreshEscrowsTotal(ch, { native: 'XRP' })).toEqual({
        drops: '1000000',
        open: 1,
        through_ledger: 250,
      });
      expect(await readEscrowed(ch)).toEqual({ drops: '1000000', open: 1, through_ledger: 250 });
      expect((await sentinelRows(ch)).pop()?.version).toBeGreaterThan(sentinel?.version ?? 0);
      // removing it again is nothing to do
      expect(await recomputeEscrows(ch, [VANISHED], { upTo: 250, native: 'XRP' })).toEqual({ written: 0, removed: 0 });
    });

    it('goes back to the older row of an escrow whose newest row a re-ingest removed', async () => {
      expect((await latestEscrows(ch)).get(REOPENED)).toMatchObject({ deleted: 1, last_ledger: 240 });
      await ch.command(
        `DELETE FROM ${Table.ObjectChanges} WHERE object_id = {id:String} AND ledger_index = 240`,
        { id: REOPENED },
        { settings: SYNC_DELETE },
      );
      // the ledger of the removed row names nothing in object_changes: only the escrow's last_ledger finds it
      expect(await escrowsOfLedgers(ch, 240, 240)).toEqual([REOPENED]);
      expect(await recomputeEscrows(ch, [REOPENED], { upTo: 250, native: 'XRP' })).toEqual({ written: 1, removed: 0 });
      expect((await latestEscrows(ch)).get(REOPENED)).toMatchObject({
        deleted: 0,
        last_ledger: 220,
        created_ledger: 220,
      });
      expect(await refreshEscrowsTotal(ch, { native: 'XRP' })).toEqual({
        drops: '9000000',
        open: 2,
        through_ledger: 250,
      });
    });

    it('has no total to refresh without a sentinel, and writes none', async () => {
      const other = await fresh();
      expect(await refreshEscrowsTotal(other, { native: 'XRP' })).toBeUndefined();
      expect(await readEscrowed(other)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('what the job reads', () => {
    // 4 × 200,000 rows of other objects in the partition of the window, and of escrows in another partition: the rows are
    // copies of one row, in four parts (merges stopped), the shape of apps/api/test/support/read-rows.ts' bulk.
    const PER_PART = 200_000;
    const GRANULE = 8192;
    const CHECK_BASES = [107_850_000, 107_860_000, 107_870_000, 107_880_000]; // in the window below
    const ESCROW_BASES = [21_000_000, 22_000_000, 23_000_000, 24_000_000]; // another partition (partitions of 10,000,000)
    const WINDOW = { from: 107_800_000, to: 107_980_000 };
    let ch: ClickHouseService;

    /** One part of `PER_PART` rows of an object: four rows a ledger from `base`. */
    async function insertBulk(objectType: string, objectId: string, base: number): Promise<void> {
      await ch.command(
        `INSERT INTO ${Table.ObjectChanges}
         SELECT {type:String}, {id:String}, toUInt32({base:UInt32} + intDiv(n.number, 4)), toUInt32(n.number % 4),
                'synthetic-bulk', toDateTime(1700000000, 'UTC'), 'EscrowCreate', 'tesSUCCESS', 'rSyntheticBulk', '',
                'created', 'create', 'rSyntheticBulk', 'rSyntheticBulk',
                '{"Account":"rSyntheticBulk","Amount":"1000000","Destination":"rSyntheticBulk"}', '{}', '{}'
           FROM numbers({n:UInt32}) AS n`,
        { type: objectType, id: objectId, base, n: PER_PART },
        { settings: { insert_deduplicate: 0 } },
      );
    }

    /** What `system.query_log` says the SELECTs on a table read while `run` ran. */
    async function reads(table: Table, run: () => Promise<unknown>): Promise<number[]> {
      const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
      await run();
      await ch.command('SYSTEM FLUSH LOGS');
      const rows = await ch.query<{ read_rows: string }>(
        `SELECT read_rows FROM system.query_log
          WHERE current_database = currentDatabase() AND type = 'QueryFinish' AND query_kind = 'Select'
            AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, concat(currentDatabase(), '.', {table:String}))
          ORDER BY query_start_time_microseconds`,
        { t, table },
      );
      return rows.map((r) => Number(r.read_rows));
    }

    const count = async (sql: string, params: Record<string, unknown> = {}): Promise<number> =>
      Number((await ch.queryOne<{ n: string }>(sql, params))?.n);

    beforeAll(async () => {
      ch = await fresh();
      // the recorded rows in one part (partition 10: ledgers 100,000,000 to 109,999,999)
      await ch.insert(Table.ObjectChanges, XRPL_CHANGES);
      await stopMerges(ch, Table.ObjectChanges);
      for (const base of CHECK_BASES) await insertBulk('Check', idOf(0xc0ffee), base);
      for (const base of ESCROW_BASES) await insertBulk('Escrow', idOf(0xe5c0), base);
    });

    it('reads the escrow rows of the partitions holding the window, and a granule or two of each part, not the other rows', async () => {
      const escrowRows = await count(
        `SELECT count() AS n FROM ${Table.ObjectChanges}
          WHERE object_type = 'Escrow' AND intDiv(ledger_index, 10000000) = intDiv({to:UInt32}, 10000000)`,
        { to: WINDOW.to },
      );
      const parts = await count(
        `SELECT count() AS n FROM system.parts
          WHERE database = currentDatabase() AND table = {table:String} AND active
            AND partition = toString(intDiv({to:UInt32}, 10000000))`,
        { table: Table.ObjectChanges, to: WINDOW.to },
      );
      const total = await count(`SELECT count() AS n FROM ${Table.ObjectChanges}`);

      let touched: string[] = [];
      const read = await reads(Table.ObjectChanges, async () => {
        touched = await escrowsTouchedIn(ch, WINDOW.from, WINDOW.to);
      });
      // the bound: its escrow rows plus two granules for each part (the tail of a part's last granule is read as well)
      const bound = escrowRows + 2 * GRANULE * parts;
      expect(parts).toBe(1 + CHECK_BASES.length);
      expect(read).toHaveLength(1);
      expect(read[0]).toBeLessThanOrEqual(bound);
      // the answer: the escrows of the recordings with a row in the window (the native timed one, and the token one made and finished)
      expect(touched).toHaveLength(2);
      expect(touched).toContain(TIMED);
      expect(touched.some((id) => id.startsWith(TOKEN_ESCROW))).toBe(true);
      // and the bound can fail: it is well below the rows of the other objects of the partition (a read of the partition's
      // rows, without the `object_type` prefix) and the escrows of the other partition (a read without the ledgers)
      expect(total).toBeGreaterThan((CHECK_BASES.length + ESCROW_BASES.length) * PER_PART);
      expect(bound).toBeLessThan(CHECK_BASES.length * PER_PART);
      expect(bound).toBeLessThan(ESCROW_BASES.length * PER_PART);
    });

    it('reads the sentinel by its key: a granule of the part that holds it, whatever else the table holds', async () => {
      await stopMerges(ch, Table.Escrows);
      // 4 × 200,000 rows of escrows, in four parts, and the sentinel in a part of its own
      for (const part of [0, 1, 2, 3]) {
        await ch.command(
          `INSERT INTO ${Table.Escrows}
           SELECT concat('BULK', toString({part:UInt32} * {n:UInt32} + n.number)), 'rSyntheticBulk', 'rSyntheticBulk', NULL, 'XRP', '',
                  '1', 1000000, NULL, NULL, 0, NULL, 1, 0, 0, 0, 1
             FROM numbers({n:UInt32}) AS n`,
          { part, n: PER_PART },
          { settings: { insert_deduplicate: 0 } },
        );
      }
      await ch.insert(Table.Escrows, [
        sentinelOf({ amount_drops: '123', open_count: 4, through_ledger: 77, version: 5 }),
      ]);
      let sentinel: Escrowed | undefined;
      const read = await reads(Table.Escrows, async () => {
        sentinel = await readEscrowed(ch);
      });
      expect(sentinel).toEqual({ drops: '123', open: 4, through_ledger: 77 });
      expect(read).toHaveLength(1);
      // the sentinel part has one row; the others start above the empty key and are not read at all
      expect(read[0]).toBeLessThanOrEqual(1 + 2 * GRANULE);
      expect(await count(`SELECT count() AS n FROM ${Table.Escrows}`)).toBe(4 * PER_PART + 1);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('more escrows than a chunk', () => {
    it('writes each chunk under one version, and all of them', async () => {
      const ch = await fresh();
      await stopMerges(ch, Table.Escrows);
      const count = 2 * ESCROWS_CHUNK + 100;
      await insertChanges(
        ch,
        Array.from({ length: count }, (_, i) =>
          create(idOf(0x1000 + i), 300, nativeFields(1_000_000, { Sequence: i + 1 }), { sequence: i + 1 }),
        ),
      );
      const [done] = await runToHead(ch, 'XRP');
      expect(done).toMatchObject({ touched: count, written: count, removed: 0 });
      expect(await readEscrowed(ch)).toEqual({ drops: String(count * 1_000_000), open: count, through_ledger: 300 });
      const [versions] = await ch.query<{ n: string }>(
        `SELECT uniqExact(version) AS n FROM ${Table.Escrows} WHERE escrow_id != ''`,
      );
      expect(Number(versions.n)).toBeLessThanOrEqual(3);
      expect((await latestEscrows(ch)).size).toBe(count);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the Xahau ledgers', () => {
    it('counts XAH escrows, with the sequence the creation took from the transaction', async () => {
      const ch = await fresh();
      await new LedgerWriter(ch, xahauCtx).write(XAHAU_LEDGERS);
      const steps = await runToHead(ch, 'XAH', 100_000_000);
      expect(steps).toHaveLength(1);
      const total = await recount(ch, steps[0].head);
      expect(total.open).toBeGreaterThan(0);
      expect(await readEscrowed(ch)).toEqual({ ...total, through_ledger: steps[0].head });
      const escrows = await latestEscrows(ch);
      // the recorded XAH escrow of 14634228: the object has no Sequence on Xahau, the creation's event has
      const native = [...escrows.values()].find((e) => e.escrow_id.startsWith('B7083D00'));
      expect(native).toMatchObject({
        currency: 'XAH',
        issuer: '',
        amount: '200',
        amount_drops: '200000000',
        sequence: 756_253_178,
        created_ledger: 14_634_228,
        deleted: 0,
      });
      // the recorded token escrow is typed in its token, and is not in the total
      expect([...escrows.values()].some((e) => e.issuer !== '' && e.amount_drops === '0')).toBe(true);
      // a finish whose creation is older than the recordings: no creation, no sequence
      expect(
        [...escrows.values()].some((e) => e.deleted === 1 && e.created_ledger === null && e.sequence === null),
      ).toBe(true);
    });
  });
});
