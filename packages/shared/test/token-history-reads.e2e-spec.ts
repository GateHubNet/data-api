import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { generatedAmount, seededRandom } from '../src/test-utils/token-history-cases';
import { ChangeAmounts, flowsOfTransaction } from '../src/token-history/flows';
import { writeHourSets } from '../src/token-history/hour-sets';
import {
  dexOfWindow,
  flowsPeriods,
  periodStart,
  SupplyPoint,
  supplySeries,
  topCounterparties,
  windowFlows,
} from '../src/token-history/reads';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

const TOKEN = { issuer: 'rIssuerOfTheReads0000000000000000', currency: 'USD' };
const FIRST = 1_000;
const LAST = 1_059;
/** A ledger every 10 minutes: 60 ledgers over 10 hours, so a window has whole hours and edges. */
const BASE = 1_700_000_400;
const closeOf = (ledger: number): number => BASE + (ledger - FIRST) * 600;
const HOUR = 3_600;

interface Change {
  ledger_index: number;
  tx_index: number;
  node_index: number;
  holder: string;
  clawback: number;
  amount_before: string;
  amount_after: string;
  counted_before: number;
  counted_after: number;
  before_known: number;
}

/** A change log of one token: a few transactions a ledger, of one to three holders each, amounts chained per holder. */
function changeLog(seed: number): Change[] {
  const rnd = seededRandom(seed);
  const amounts = new Map<string, string>();
  const out: Change[] = [];
  for (let ledger = FIRST; ledger <= LAST; ledger++) {
    const txs = Math.floor(rnd() * 3);
    for (let tx = 0; tx < txs; tx++) {
      const clawback = rnd() < 0.15 ? 1 : 0;
      const holders = new Set<string>();
      const n = 1 + Math.floor(rnd() * 3);
      while (holders.size < n) holders.add(`rHolder${Math.floor(rnd() * 8)}`.padEnd(33, '0'));
      let node = 0;
      for (const holder of holders) {
        const before = amounts.get(holder);
        const after = rnd() < 0.2 ? '0' : new BigNumber(generatedAmount(rnd)).abs().toFixed();
        amounts.set(holder, after);
        out.push({
          ledger_index: ledger,
          tx_index: tx,
          node_index: node++,
          holder,
          clawback,
          amount_before: before ?? '0',
          amount_after: after,
          // a holder's first change creates its line
          counted_before: before === undefined ? 0 : 1,
          counted_after: 1,
          before_known: rnd() < 0.1 ? 0 : 1,
        });
      }
    }
  }
  return out;
}

/** The oracle: the flows of every transaction of the window, by `flowsOfTransaction`, summed. */
function bruteFlows(log: Change[], from: number, to: number) {
  const byTx = new Map<string, { clawback: boolean; changes: ChangeAmounts[] }>();
  for (const c of log) {
    if (c.ledger_index < from || c.ledger_index > to) continue;
    const key = `${c.ledger_index}:${c.tx_index}`;
    const tx = byTx.get(key) ?? { clawback: c.clawback === 1, changes: [] };
    tx.changes.push({ before: c.amount_before, after: c.amount_after, beforeKnown: c.before_known === 1 });
    byTx.set(key, tx);
  }
  const sum = {
    issued: new BigNumber(0),
    redeemed: new BigNumber(0),
    clawed_back: new BigNumber(0),
    transferred: new BigNumber(0),
  };
  let transfers = 0;
  let changes = 0;
  let unknown = 0;
  for (const tx of byTx.values()) {
    const f = flowsOfTransaction(tx.changes, tx.clawback);
    sum.issued = sum.issued.plus(f.issued);
    sum.redeemed = sum.redeemed.plus(f.redeemed);
    sum.clawed_back = sum.clawed_back.plus(f.clawed_back);
    sum.transferred = sum.transferred.plus(f.transferred);
    transfers += f.transfers;
    changes += tx.changes.length;
    unknown += f.unknown_before;
  }
  const t = (n: BigNumber) => (n.isZero() ? '0' : n.toFixed());
  return {
    issued: t(sum.issued),
    redeemed: t(sum.redeemed),
    clawed_back: t(sum.clawed_back),
    transferred: t(sum.transferred),
    transfers,
    changes,
    unknown_before: unknown,
  };
}

/** The levels of the token after every change closed before `t` (or at ledgers up to `ledger`), from the change log. */
function bruteLevels(log: Change[], upTo: (c: Change) => boolean) {
  const amounts = new Map<string, string>();
  let ledger = 0;
  for (const c of log) {
    if (!upTo(c)) continue;
    amounts.set(c.holder, c.amount_after);
    ledger = c.ledger_index;
  }
  const values = [...amounts.values()];
  const supply = values.reduce((s, a) => s.plus(a), new BigNumber(0));
  return {
    amounts,
    ledger,
    supply,
    holders: values.filter((a) => new BigNumber(a).gt(0)).length,
    trust_lines: values.length,
  };
}

const t = (n: BigNumber) => (n.isZero() ? '0' : n.toFixed());

/** The oracle of a row of the series: the levels at its end, the flows of its ledgers, and the levels without `exclude`. */
function brutePoint(
  log: Change[],
  time: number,
  ledgers: [number, number],
  end: (c: Change) => boolean,
  exclude?: string[],
): SupplyPoint {
  const lv = bruteLevels(log, end);
  const f = bruteFlows(log, ledgers[0], ledgers[1]);
  const point: SupplyPoint = {
    time,
    ledger_index: lv.ledger,
    supply: t(lv.supply),
    holders: lv.holders,
    trust_lines: lv.trust_lines,
    issued: f.issued,
    redeemed: f.redeemed,
    clawed_back: f.clawed_back,
    net: t(new BigNumber(f.issued).minus(f.redeemed).minus(f.clawed_back)),
    unknown_before: f.unknown_before,
  };
  if (exclude !== undefined) {
    let supply = lv.supply;
    let holders = lv.holders;
    let lines = lv.trust_lines;
    for (const x of exclude) {
      const a = lv.amounts.get(x);
      if (a === undefined) continue;
      lines -= 1;
      if (new BigNumber(a).gt(0)) {
        supply = supply.minus(a);
        holders -= 1;
      }
    }
    point.without_excluded = { supply: t(supply), holders, trust_lines: lines };
  }
  return point;
}

/** The ledgers whose close is in `[a, b)`. */
const ledgersIn = (a: number, b: number): [number, number] => {
  const ls = Array.from({ length: LAST - FIRST + 1 }, (_, i) => FIRST + i).filter(
    (l) => closeOf(l) >= a && closeOf(l) < b,
  );
  return ls.length === 0 ? [1, 0] : [ls[0], ls[ls.length - 1]];
};

describe('the reads of the token history routes (e2e)', () => {
  let container: StartedClickHouse;
  let ch: ClickHouseService;
  let log: Change[];

  beforeAll(async () => {
    container = await startClickHouse();
    const config = { ...container.config, database: 'token_history_reads' };
    await runMigrations({ config, log: () => undefined });
    ch = new ClickHouseService(config);
    await ch.insert(
      Table.Ledgers,
      Array.from({ length: LAST - FIRST + 1 }, (_, i) => ({
        ...SAMPLE_ROWS[Table.Ledgers],
        ledger_index: FIRST + i,
        ledger_hash: String(FIRST + i).padStart(64, 'C'),
        close_time: closeOf(FIRST + i),
      })),
    );
    log = changeLog(7);
    await ch.insert(
      Table.TokenHolderChanges,
      log.map((c) => ({
        ...SAMPLE_ROWS[Table.TokenHolderChanges],
        ...c,
        generation: 1,
        issuer: TOKEN.issuer,
        currency: TOKEN.currency,
        close_time: closeOf(c.ledger_index),
      })),
    );
    const hours = [...new Set(log.map((c) => Math.floor(closeOf(c.ledger_index) / HOUR) * HOUR))].map(
      (h) => new Date(h * 1000),
    );
    await writeHourSets(ch, 1, TOKEN, hours, LAST);
  }, 180_000);

  afterAll(async () => {
    await ch?.close();
    await container?.container.stop();
  });

  it('the flows of a window equal the brute force of its transactions, edges and whole hours alike', async () => {
    expect(log.length).toBeGreaterThan(40);
    const windows: [number, number][] = [
      [FIRST, LAST],
      [FIRST, FIRST],
      [FIRST + 1, FIRST + 4],
      [FIRST + 3, FIRST + 9],
      [FIRST + 5, FIRST + 31],
      [FIRST + 17, LAST - 2],
      [FIRST + 12, FIRST + 17],
      [LAST, LAST],
    ];
    for (const [from, to] of windows) {
      expect({ from, to, flows: await windowFlows(ch, 1, TOKEN, from, to) }).toEqual({
        from,
        to,
        flows: bruteFlows(log, from, to),
      });
    }
    // an empty window, and another token
    expect((await windowFlows(ch, 1, TOKEN, FIRST + 5, FIRST + 4)).changes).toBe(0);
    expect((await windowFlows(ch, 1, { ...TOKEN, currency: 'EUR' }, FIRST, LAST)).changes).toBe(0);
  });

  it('the DEX figures sum the hours with a sentinel, ignore a row older than its sentinel, and say whether every hour has one', async () => {
    const h0 = Math.floor(closeOf(FIRST) / HOUR) * HOUR;
    const dex = (
      hour: number,
      issuer: string,
      currency: string,
      exchanged: string,
      trades: number,
      version: number,
    ) => ({
      issuer,
      currency,
      hour,
      exchanged,
      trades,
      config_version: 1,
      version,
    });
    await ch.insert(Table.TokenHourlyDex, [
      dex(h0, TOKEN.issuer, TOKEN.currency, '1.5', 2, 10),
      dex(h0, '', '', '0', 0, 10),
      dex(h0 + HOUR, TOKEN.issuer, TOKEN.currency, '100', 7, 10),
      // the hour was written again without the token: its old row is older than the new sentinel
      dex(h0 + HOUR, '', '', '0', 0, 20),
      dex(h0 + 2 * HOUR, TOKEN.issuer, TOKEN.currency, '2.25', 1, 30),
      dex(h0 + 2 * HOUR, '', '', '0', 0, 30),
    ]);
    expect(await dexOfWindow(ch, TOKEN, h0, h0 + 3 * HOUR)).toEqual({
      exchanged: '3.75',
      trades: 3,
      through: new Date((h0 + 3 * HOUR) * 1000),
      complete: true,
    });
    // a window with an hour past the newest sentinel: the figures are up to it, and incomplete
    expect(await dexOfWindow(ch, TOKEN, h0 + 2 * HOUR, h0 + 5 * HOUR)).toEqual({
      exchanged: '2.25',
      trades: 1,
      through: new Date((h0 + 3 * HOUR) * 1000),
      complete: false,
    });
    expect(await dexOfWindow(ch, TOKEN, h0 + 4 * HOUR, h0 + 6 * HOUR)).toBeUndefined();
  });
  const DAY = 86_400;
  const HOLDERS = Array.from({ length: 8 }, (_, i) => `rHolder${i}`.padEnd(33, '0'));

  it('day buckets carry levels forward and sum their hours, hour buckets too, with exclude on every row', async () => {
    for (const [interval, size] of [
      ['hour', HOUR],
      ['day', DAY],
    ] as const) {
      const from = periodStart(closeOf(FIRST), interval);
      const to = periodStart(closeOf(LAST), interval);
      const exclude = [HOLDERS[1], HOLDERS[3], 'rNeverHeldThisToken000000000000000'];
      const rows = await supplySeries(ch, 1, TOKEN, {
        interval,
        from,
        to,
        toLedger: LAST,
        descending: false,
        limit: 1_000,
        exclude,
      });
      const expected: SupplyPoint[] = [];
      for (let b = from; b <= to; b += size) {
        expected.push(brutePoint(log, b, ledgersIn(b, b + size), (c) => closeOf(c.ledger_index) < b + size, exclude));
      }
      expect({ interval, rows }).toEqual({ interval, rows: expected });
      if (interval === 'day') expect(rows.length).toBe(2);
    }
  });

  it('pages concatenate to the unpaged series in both directions, by hour and by ledger', async () => {
    const from = periodStart(closeOf(FIRST), 'hour');
    const to = periodStart(closeOf(LAST), 'hour');
    for (const o of [
      { interval: 'hour' as const, from, to },
      { interval: 'ledger' as const, from: FIRST + 3, to: LAST - 3 },
    ]) {
      for (const descending of [false, true]) {
        const whole = await supplySeries(ch, 1, TOKEN, { ...o, toLedger: LAST, descending, limit: 1_000 });
        const pages: SupplyPoint[] = [];
        let after: number | undefined;
        for (let i = 0; i < 100; i++) {
          const rows = await supplySeries(ch, 1, TOKEN, { ...o, toLedger: LAST, descending, limit: 3, after });
          pages.push(...rows.slice(0, 3));
          if (rows.length <= 3) break;
          const last = rows[2];
          after = o.interval === 'ledger' ? last.ledger_index : last.time;
        }
        expect({ o, descending, pages }).toEqual({ o, descending, pages: whole });
      }
    }
  });

  it('interval ledger lists the ledgers with changes, the levels after each', async () => {
    const exclude = [HOLDERS[2]];
    const rows = await supplySeries(ch, 1, TOKEN, {
      interval: 'ledger',
      from: FIRST,
      to: LAST,
      toLedger: LAST,
      descending: false,
      limit: 1_000,
      exclude,
    });
    const ledgers = [...new Set(log.map((c) => c.ledger_index))];
    expect(rows.map((r) => r.ledger_index)).toEqual(ledgers);
    expect(rows).toEqual(ledgers.map((l) => brutePoint(log, closeOf(l), [l, l], (c) => c.ledger_index <= l, exclude)));
  });

  it('flows totals equal the sum of the periods, and the brute force, by hour, day and month', async () => {
    const start = closeOf(FIRST + 2) + 7;
    const end = closeOf(LAST - 1) + 1;
    for (const interval of ['hour', 'day', 'month'] as const) {
      const got = await flowsPeriods(ch, 1, TOKEN, { fromLedger: FIRST + 3, toLedger: LAST - 1, start, end, interval });
      expect(got.totals).toEqual(bruteFlows(log, FIRST + 3, LAST - 1));
      const summed = { changes: 0, transfers: 0, unknown_before: 0, issued: new BigNumber(0) };
      for (const p of got.periods) {
        summed.changes += p.changes;
        summed.transfers += p.transfers;
        summed.unknown_before += p.unknown_before;
        summed.issued = summed.issued.plus(p.issued);
      }
      expect({ interval, summed: { ...summed, issued: t(summed.issued) } }).toEqual({
        interval,
        summed: {
          changes: got.totals.changes,
          transfers: got.totals.transfers,
          unknown_before: got.totals.unknown_before,
          issued: got.totals.issued,
        },
      });
      expect(got.periods[0].start).toBe(periodStart(start, interval));
    }
  });

  /** The brute force of the counterparties of `[from, to]`. */
  function bruteCounterparties(from: number, to: number, n: number) {
    const sums = new Map<string, { received: BigNumber; sent: BigNumber; changes: number }>();
    for (const c of log) {
      if (c.ledger_index < from || c.ledger_index > to) continue;
      const s = sums.get(c.holder) ?? { received: new BigNumber(0), sent: new BigNumber(0), changes: 0 };
      s.changes += 1;
      if (c.before_known === 1) {
        const d = new BigNumber(c.amount_after).minus(c.amount_before);
        if (d.gt(0)) s.received = s.received.plus(d);
        else s.sent = s.sent.minus(d);
      }
      sums.set(c.holder, s);
    }
    return [...sums.entries()]
      .sort(([a, x], [b, y]) => y.received.plus(y.sent).comparedTo(x.received.plus(x.sent)) || (a < b ? -1 : 1))
      .slice(0, n)
      .map(([account, s]) => ({
        account,
        received: t(s.received),
        sent: t(s.sent),
        net: t(s.received.minus(s.sent)),
        changes: s.changes,
      }));
  }

  it('top counterparties of a ledger equal the brute force, a holder that only received or only sent too', async () => {
    for (let l = FIRST; l <= LAST; l++) {
      expect({ l, top: await topCounterparties(ch, 1, TOKEN, l, l, 10) }).toEqual({
        l,
        top: bruteCounterparties(l, l, 10),
      });
    }
  });

  it('top counterparties equal the brute force', async () => {
    const [from, to] = [FIRST + 4, LAST - 6];
    const sums = new Map<string, { received: BigNumber; sent: BigNumber; changes: number }>();
    for (const c of log) {
      if (c.ledger_index < from || c.ledger_index > to) continue;
      const s = sums.get(c.holder) ?? { received: new BigNumber(0), sent: new BigNumber(0), changes: 0 };
      s.changes += 1;
      if (c.before_known === 1) {
        const d = new BigNumber(c.amount_after).minus(c.amount_before);
        if (d.gt(0)) s.received = s.received.plus(d);
        else s.sent = s.sent.minus(d);
      }
      sums.set(c.holder, s);
    }
    const expected = [...sums.entries()]
      .sort(([a, x], [b, y]) => y.received.plus(y.sent).comparedTo(x.received.plus(x.sent)) || (a < b ? -1 : 1))
      .slice(0, 5)
      .map(([account, s]) => ({
        account,
        received: t(s.received),
        sent: t(s.sent),
        net: t(s.received.minus(s.sent)),
        changes: s.changes,
      }));
    expect(await topCounterparties(ch, 1, TOKEN, from, to, 5)).toEqual(expected);
  });
});
