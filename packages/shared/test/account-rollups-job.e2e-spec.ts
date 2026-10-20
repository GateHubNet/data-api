import {
  ACCOUNT_PARTITION_ROWS_FLOOR,
  accountPartitionRows,
  ADDRESS_SLICE_CHARS,
  BALANCE_PARTITION_LEDGERS,
  firstChangeDay,
  heavyAccounts,
  partitionDays,
  partitionFirstDay,
  partitionOf,
  partitionSetVersions,
  recountPartition,
} from '../src/aggregate/account-rollups.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The discovery of heavy accounts (`account-rollups.job.ts`: `recountPartition`, `heavyAccounts`, `accountPartitionRows`,
 * `partitionSetVersions`, `firstChangeDay`, `partitionDays`, `partitionFirstDay`) on a real ClickHouse.
 *
 * The world is synthetic `balance_changes` of made-up accounts, written with `INSERT ... SELECT FROM numbers()` into
 * the first two partitions of the table (ledgers below and from 10,000,000). The accounts sit on both sides of the floor
 * of 10,000 rows (exactly on it, one under it, far over it), in the first and the last slice and on the edges of the slices
 * (the second character of the address is the slice), in one partition or both, and one of them is written in three
 * inserts. Merges of the tables are stopped, so row counts are exact and the rows of older sets stay where a test can see
 * them. An oracle written from the definition of the world (plain arithmetic, never the code under test) says what
 * every set has to hold.
 */

const FLOOR = ACCOUNT_PARTITION_ROWS_FLOOR;
const P = BALANCE_PARTITION_LEDGERS;

/** A made-up account of 34 characters; `head` is its first characters, the second one picks its slice. */
const account = (head: string): string => head.padEnd(34, 'x');

/** The rows an account has in each partition (index = partition), and how many inserts write them. */
interface Heavy {
  account: string;
  rows: number[];
  inserts?: number;
}
const WORLD: Heavy[] = [
  { account: account('r1Low'), rows: [FLOOR, FLOOR / 2] }, // exactly on the floor in 0, far under in 1: only 0 keeps it
  { account: account('rzHigh'), rows: [12_000, FLOOR] }, // the last slice; on the floor in 1
  { account: account('rNMid'), rows: [FLOOR - 1, 20_000] }, // one under the floor in 0, over it in 1
  { account: account('raSplit'), rows: [30_000, 0], inserts: 3 }, // written in three parts
  { account: account('rbDust'), rows: [9_000, 9_000] }, // 18,000 in all, and in no set
  { account: account('XOther'), rows: [FLOOR, 0] }, // below 'r2': the first slice has no lower bound
  { account: account('sOther'), rows: [0, FLOOR] }, // above 'rz': the last slice has no upper bound
  { account: account('r2Edge'), rows: [FLOOR, FLOOR] }, // the first address of the second slice
  { account: account('ryEdge'), rows: [FLOOR, FLOOR] }, // the slice before the last: [ry, rz)
];

/** What the set of a partition has to hold, by the definition of the world. */
const expectedSet = (partition: number): Map<string, number> =>
  new Map(WORLD.filter((w) => w.rows[partition] >= FLOOR).map((w) => [w.account, w.rows[partition]]));

/** What `heavyAccounts(minRows)` has to answer when the newest set of each partition is the one of the world. */
const expectedHeavy = (minRows: number): Map<string, number> => {
  const sums = new Map<string, number>();
  for (const partition of [0, 1]) {
    for (const [name, rows] of expectedSet(partition)) sums.set(name, (sums.get(name) ?? 0) + rows);
  }
  return new Map([...sums].filter(([, rows]) => rows >= minRows));
};

const sorted = <V>(map: Map<string, V>): [string, V][] => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe('heavy-account discovery (e2e)', () => {
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

  /** A migrated database of its own, with the merges of the tables the tests read stopped. */
  async function freshService(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `account_rollups_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    // `SYSTEM STOP MERGES` needs the database the service is bound to
    for (const table of [Table.BalanceChanges, Table.AccountPartitionRows, Table.Ledgers]) {
      await svc.command(`SYSTEM STOP MERGES ${config.database}.${table}`);
    }
    return svc;
  }

  /** `n` balance changes of the account on the ledgers from `firstLedger` up, one per ledger, closed at `closeTime`. */
  async function addChanges(
    ch: ClickHouseService,
    name: string,
    firstLedger: number,
    n: number,
    closeTime = '2016-03-04 12:00:00',
  ): Promise<void> {
    if (n === 0) return;
    await ch.command(
      `INSERT INTO ${Table.BalanceChanges}
         (account, ledger_index, tx_index, node_index, close_time, currency, counterparty, amount_change, final_balance, final_balance_f, change_type)
       SELECT {account:String}, {first:UInt32} + toUInt32(number), 0, 0, toDateTime({closed:String}, 'UTC'),
              'USD', 'rIssuer', '1', toString(number), toFloat64(number), 'payment_destination'
         FROM numbers({n:UInt64})`,
      { account: name, first: firstLedger, n, closed: closeTime },
    );
  }

  /** The world, or what is given of it: every account's rows in each partition, on ledgers of that partition. */
  async function writeWorld(ch: ClickHouseService, world: Heavy[]): Promise<void> {
    for (const w of world) {
      for (const [partition, rows] of w.rows.entries()) {
        const parts = w.inserts ?? 1;
        const each = rows / parts;
        for (let i = 0; i < parts; i++) await addChanges(ch, w.account, partition * P + 1000 + i * each, each);
      }
    }
  }

  /** The balance-change reads of a call of `body`: the queries of the slices of a recount. */
  async function sliceReads(
    ch: ClickHouseService,
    body: () => Promise<unknown>,
  ): Promise<{ sql: string; params: Record<string, unknown> }[]> {
    const spy = jest.spyOn(ch, 'query');
    try {
      await body();
      return spy.mock.calls
        .filter(([sql]) => sql.includes(`FROM ${Table.BalanceChanges}`))
        .map(([sql, params]) => ({ sql, params: params ?? {} }));
    } finally {
      spy.mockRestore();
    }
  }

  /** The rows of a partition as the table holds them (every set), by version. */
  async function storedRows(
    ch: ClickHouseService,
    partition: number,
  ): Promise<{ account: string; rows: number; version: number }[]> {
    const rows = await ch.query<{ account: string; rows: string; version: string }>(
      `SELECT account, rows, version FROM ${Table.AccountPartitionRows} WHERE partition = {partition:UInt16} ORDER BY version, account`,
      { partition },
    );
    return rows.map((r) => ({ account: r.account, rows: Number(r.rows), version: Number(r.version) }));
  }

  // -------------------------------------------------------------------------------------------------------------------
  describe('on the synthetic world', () => {
    let ch: ClickHouseService;

    beforeAll(async () => {
      ch = await freshService();
      await writeWorld(ch, WORLD);
    });

    it('the world has what the tests rely on', async () => {
      // the rows are in the tables exactly as many times as written (nothing merged), in the partition they belong to
      const rows = await ch.query<{ account: string; partition: string; n: string }>(
        `SELECT account, intDiv(ledger_index, 10000000) AS partition, count() AS n FROM ${Table.BalanceChanges} GROUP BY account, partition`,
      );
      const stored = new Map(rows.map((r) => [`${r.account}/${r.partition}`, Number(r.n)]));
      for (const w of WORLD) {
        for (const [partition, n] of w.rows.entries()) expect(stored.get(`${w.account}/${partition}`) ?? 0).toBe(n);
      }
      expect(stored.size).toBe(WORLD.reduce((n, w) => n + w.rows.filter((r) => r > 0).length, 0));
      // every account is in the slice its second character gives, or is outside the alphabet range of the slices
      const second = (name: string): string => name[1];
      expect(second(WORLD[0].account)).toBe('1');
      expect(second(WORLD[1].account)).toBe('z');
      expect(WORLD[5].account < `r${ADDRESS_SLICE_CHARS[1]}`).toBe(true);
      expect(WORLD[6].account >= `r${ADDRESS_SLICE_CHARS[57]}`).toBe(true);
      expect(partitionOf(1000)).toBe(0);
      expect(partitionOf(P + 1000)).toBe(1);
      // the sets the tests expect: six accounts in the first partition, five in the second
      expect(expectedSet(0).size).toBe(6);
      expect(expectedSet(1).size).toBe(5);
    });

    it('recountPartition reads the partition in 58 slices by the second character of the address, and keeps the accounts of 10,000 rows or more', async () => {
      const reads = await sliceReads(ch, async () => {
        expect(await recountPartition(ch, 0)).toBe(expectedSet(0).size);
      });
      expect(reads).toHaveLength(58);
      const chars = [...ADDRESS_SLICE_CHARS];
      reads.forEach(({ sql, params }, i) => {
        expect(params).toEqual({
          p_min: 0,
          p_max: P - 1,
          floor: FLOOR,
          ...(i > 0 && { lo: `r${chars[i]}` }),
          ...(i < 57 && { hi: `r${chars[i + 1]}` }),
        });
        expect(sql.includes('account >= {lo:String}')).toBe(i > 0);
        expect(sql.includes('account < {hi:String}')).toBe(i < 57);
      });
      // the first slice has no lower bound and the last none above; the slices in between meet end to start
      expect(reads[0].params).not.toHaveProperty('lo');
      expect(reads[57].params).not.toHaveProperty('hi');
      for (let i = 0; i < 57; i++) expect(reads[i].params.hi).toBe(reads[i + 1].params.lo);

      // the set: the accounts of the oracle with their exact counts, and the sentinel, one insert and one version
      const stored = await storedRows(ch, 0);
      const versions = new Set(stored.map((r) => r.version));
      expect(versions.size).toBe(1);
      expect(stored.filter((r) => r.account !== '').map((r) => [r.account, r.rows])).toEqual(sorted(expectedSet(0)));
      expect(stored.filter((r) => r.account === '')).toHaveLength(1);
      const [parts] = await ch.query<{ n: string }>(
        `SELECT uniqExact(_part) AS n FROM ${Table.AccountPartitionRows} WHERE partition = 0`,
      );
      expect(Number(parts.n)).toBe(1);
      // nothing below the floor is in it, nor the account of 9,999 rows, nor the dust
      const names = stored.map((r) => r.account);
      expect(names).not.toContain(WORLD[2].account);
      expect(names).not.toContain(WORLD[4].account);
      // the other partitions have no set yet; the version of this one is the version of its rows
      expect(await storedRows(ch, 1)).toEqual([]);
      const setVersions = await partitionSetVersions(ch);
      expect([...setVersions]).toEqual([[0, [...versions][0]]]);
    });

    it('heavyAccounts sums each account over the newest set of every partition', async () => {
      await recountPartition(ch, 0); // a second set of the first partition: the first one is not summed again
      await recountPartition(ch, 1);
      await recountPartition(ch, 2); // no balance change: a set of the sentinel alone
      expect(await storedRows(ch, 2)).toHaveLength(1);

      const versions = await partitionSetVersions(ch);
      expect([...versions.keys()].sort()).toEqual([0, 1, 2]);

      // an account is kept when the sum reaches minRows: on the sum, not under it
      expect(sorted(await heavyAccounts(ch, FLOOR))).toEqual(sorted(expectedHeavy(FLOOR)));
      expect(sorted(await heavyAccounts(ch, 20_000))).toEqual(sorted(expectedHeavy(20_000)));
      expect(sorted(await heavyAccounts(ch, 22_000))).toEqual(sorted(expectedHeavy(22_000)));
      expect(sorted(await heavyAccounts(ch, 30_000))).toEqual([[WORLD[3].account, 30_000]]);
      expect(await heavyAccounts(ch, 30_001)).toEqual(new Map());
      // what is in the sets, whatever the minimum; an account under the floor of every partition is in none
      expect(sorted(await heavyAccounts(ch, 0))).toEqual(sorted(expectedHeavy(0)));
      expect((await heavyAccounts(ch, 0)).has(WORLD[4].account)).toBe(false);
      // sums, not maxima: the account in both partitions
      expect((await heavyAccounts(ch, 0)).get(WORLD[1].account)).toBe(22_000);
      // an account under the floor in one partition counts the other only
      expect((await heavyAccounts(ch, 0)).get(WORLD[0].account)).toBe(FLOOR);
      expect((await heavyAccounts(ch, 0)).get(WORLD[2].account)).toBe(20_000);
    });

    it('heavyAccounts reads each row of a set once, though the insert of the set was repeated', async () => {
      const [sentinel] = (await storedRows(ch, 1)).filter((r) => r.account === '');
      const again = (await storedRows(ch, 1)).filter((r) => r.version === sentinel.version);
      await ch.insert(
        Table.AccountPartitionRows,
        again.map((r) => ({ partition: 1, account: r.account, rows: r.rows, version: r.version })),
      );
      const [{ n }] = await ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.AccountPartitionRows} WHERE partition = 1`,
      );
      expect(Number(n)).toBe(2 * again.length); // written twice, not merged
      expect(sorted(await heavyAccounts(ch, FLOOR))).toEqual(sorted(expectedHeavy(FLOOR)));
      expect((await accountPartitionRows(ch, WORLD[1].account)).get(1)).toBe(FLOOR);
    });

    it('accountPartitionRows gives the rows of an account in each partition whose newest set holds it', async () => {
      expect(await accountPartitionRows(ch, WORLD[1].account)).toEqual(
        new Map([
          [0, 12_000],
          [1, FLOOR],
        ]),
      );
      expect(await accountPartitionRows(ch, WORLD[0].account)).toEqual(new Map([[0, FLOOR]]));
      expect(await accountPartitionRows(ch, WORLD[2].account)).toEqual(new Map([[1, 20_000]]));
      expect(await accountPartitionRows(ch, WORLD[3].account)).toEqual(new Map([[0, 30_000]]));
      // nothing for an account under the floor everywhere, an unknown one, and the sentinel's own key
      expect(await accountPartitionRows(ch, WORLD[4].account)).toEqual(new Map());
      expect(await accountPartitionRows(ch, account('rUnknown'))).toEqual(new Map());
      expect(await accountPartitionRows(ch, '')).toEqual(new Map());
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a recount', () => {
    it('is a newer set; an account below the floor is gone from it', async () => {
      const ch = await freshService();
      const [stays, drops, grows] = [account('rAStays'), account('rBDrops'), account('rCGrows')];
      await writeWorld(ch, [
        { account: stays, rows: [FLOOR] },
        { account: drops, rows: [FLOOR] },
        { account: grows, rows: [FLOOR] },
      ]);
      await recountPartition(ch, 0);
      const [{ version: v1 }] = await storedRows(ch, 0);
      expect(sorted(await heavyAccounts(ch, FLOOR))).toEqual(
        sorted(
          new Map([
            [stays, FLOOR],
            [drops, FLOOR],
            [grows, FLOOR],
          ]),
        ),
      );

      // the ledgers of the partition change under the set: one account loses rows, another gains some
      await ch.command(`ALTER TABLE ${Table.BalanceChanges} DROP PARTITION 0`);
      await writeWorld(ch, [
        { account: stays, rows: [FLOOR] },
        { account: drops, rows: [FLOOR - 1] },
        { account: grows, rows: [FLOOR + 5_000] },
      ]);
      expect(await recountPartition(ch, 0)).toBe(2);

      const versions = await partitionSetVersions(ch);
      const v2 = versions.get(0) as number;
      expect(v2).toBeGreaterThan(v1);
      // both sets are in the table (nothing merged), the older one unread
      const stored = await storedRows(ch, 0);
      expect(new Set(stored.map((r) => r.version))).toEqual(new Set([v1, v2]));
      expect(stored.filter((r) => r.version === v1 && r.account === drops)).toHaveLength(1);
      expect(stored.filter((r) => r.version === v2 && r.account === drops)).toHaveLength(0);

      expect(sorted(await heavyAccounts(ch, 0))).toEqual(
        sorted(
          new Map([
            [stays, FLOOR],
            [grows, FLOOR + 5_000],
          ]),
        ),
      );
      expect(await accountPartitionRows(ch, drops)).toEqual(new Map());
      expect(await accountPartitionRows(ch, grows)).toEqual(new Map([[0, FLOOR + 5_000]]));
    });

    it('does not touch the set of another partition', async () => {
      const ch = await freshService();
      const name = account('rAPair');
      await writeWorld(ch, [{ account: name, rows: [FLOOR, FLOOR] }]);
      await recountPartition(ch, 0);
      await recountPartition(ch, 1);
      const before = await partitionSetVersions(ch);
      await recountPartition(ch, 1);
      const after = await partitionSetVersions(ch);
      expect(after.get(0)).toBe(before.get(0));
      expect(after.get(1)).toBeGreaterThan(before.get(1) as number);
      expect(await accountPartitionRows(ch, name)).toEqual(
        new Map([
          [0, FLOOR],
          [1, FLOOR],
        ]),
      );
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('firstChangeDay', () => {
    it("is the UTC day of the account's first balance change", async () => {
      const ch = await freshService();
      const name = account('rFirst');
      // written newest first, in separate parts, with the fee row (node_index -1) of the first ledger: the key decides
      await addChanges(ch, name, 9_000, 3, '2016-03-07 00:00:00');
      await addChanges(ch, name, 5_001, 2, '2016-03-05 00:00:00');
      await addChanges(ch, name, 5_000, 1, '2016-03-04 23:59:59');
      await ch.command(
        `INSERT INTO ${Table.BalanceChanges} (account, ledger_index, tx_index, node_index, close_time)
         SELECT {account:String}, 5000, 0, -1, toDateTime('2016-03-04 23:59:59', 'UTC')`,
        { account: name },
      );
      expect(await firstChangeDay(ch, name)).toBe('2016-03-04');

      // the first second of a day is that day
      const midnight = account('rMidnight');
      await addChanges(ch, midnight, 100, 1, '2013-01-01 00:00:00');
      await addChanges(ch, midnight, 101, 1, '2013-01-02 00:00:00');
      expect(await firstChangeDay(ch, midnight)).toBe('2013-01-01');

      // another account's earlier rows are not this account's
      await addChanges(ch, account('rOther'), 1, 5, '2012-01-01 00:00:00');
      expect(await firstChangeDay(ch, name)).toBe('2016-03-04');
      expect(await firstChangeDay(ch, account('rNobody'))).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('partitionDays', () => {
    it("spans the partition's ledgers", async () => {
      const ch = await freshService();
      const ledger = (index: number, closed: string): Promise<void> =>
        ch.command(
          `INSERT INTO ${Table.Ledgers} (ledger_index, close_time) SELECT {index:UInt32}, toDateTime({closed:String}, 'UTC')`,
          { index, closed },
        );
      // partition 1: across midnight twice, three UTC days, with a ledger of partition 0 and one of partition 2 around it
      await ledger(P - 1, '2016-01-01 00:00:00');
      await ledger(P + 1, '2016-03-04 23:00:00');
      await ledger(P + 500, '2016-03-05 12:00:00');
      await ledger(P + 900, '2016-03-06 01:00:00');
      await ledger(2 * P, '2016-12-31 00:00:00');
      // partition 3: the same day from its first to its last second
      await ledger(3 * P + 1, '2016-03-04 00:00:00');
      await ledger(3 * P + 50, '2016-03-04 23:59:59');
      // partition 4: the last second of a day and the first of the next
      await ledger(4 * P + 1, '2016-03-04 23:59:59');
      await ledger(4 * P + 2, '2016-03-05 00:00:00');
      // partition 5: one ledger
      await ledger(5 * P + 7, '2016-03-04 10:00:00');
      // partition 6: over the leap day
      await ledger(6 * P + 1, '2016-02-28 20:00:00');
      await ledger(6 * P + 2, '2016-03-01 01:00:00');

      expect(await partitionDays(ch, 1)).toBe(3);
      expect(await partitionDays(ch, 3)).toBe(1);
      expect(await partitionDays(ch, 4)).toBe(2);
      expect(await partitionDays(ch, 5)).toBe(1);
      expect(await partitionDays(ch, 6)).toBe(3);
      // a partition with one ledger (2: its first one) and one with none are at least one day
      expect(await partitionDays(ch, 2)).toBe(1);
      expect(await partitionDays(ch, 7)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('partitionFirstDay', () => {
    it('is the UTC day of the first ledger of the partition, and none for a partition without a ledger', async () => {
      const ch = await freshService();
      const ledger = (index: number, closed: string): Promise<void> =>
        ch.command(
          `INSERT INTO ${Table.Ledgers} (ledger_index, close_time) SELECT {index:UInt32}, toDateTime({closed:String}, 'UTC')`,
          { index, closed },
        );
      // partition 0: its last ledgers; the ledgers of the neighbours are not its own
      await ledger(P - 2, '2016-03-03 23:59:58');
      await ledger(P - 1, '2016-03-03 23:59:59');
      // partition 1: the first ledger is not the one with the lowest index inserted first, and the next day follows
      await ledger(P + 900, '2016-03-05 01:00:00');
      await ledger(P + 1, '2016-03-04 00:00:00');
      await ledger(P + 500, '2016-03-04 12:00:00');
      // partition 3: one ledger, on the last second of a day
      await ledger(3 * P + 7, '2016-02-29 23:59:59');
      // partition 4: its first ledger is the first second of a day (the leap day)
      await ledger(4 * P, '2016-02-29 00:00:00');
      await ledger(4 * P + 1, '2016-03-01 00:00:00');

      expect(await partitionFirstDay(ch, 0)).toBe('2016-03-03');
      expect(await partitionFirstDay(ch, 1)).toBe('2016-03-04');
      expect(await partitionFirstDay(ch, 3)).toBe('2016-02-29');
      expect(await partitionFirstDay(ch, 4)).toBe('2016-02-29');
      // a partition with no ledger has no first day (not 1970-01-01)
      expect(await partitionFirstDay(ch, 2)).toBeUndefined();
      expect(await partitionFirstDay(ch, 9)).toBeUndefined();
    });
  });
});
