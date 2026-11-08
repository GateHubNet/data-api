import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { generatedAmount, seededRandom } from '../src/test-utils/token-history-cases';
import { ChangeAmounts, flowsOfTransaction } from '../src/token-history/flows';
import { writeHourSets } from '../src/token-history/hour-sets';
import { dexOfWindow, windowFlows } from '../src/token-history/reads';
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
        const before = amounts.get(holder) ?? '0';
        const after = rnd() < 0.2 ? '0' : new BigNumber(generatedAmount(rnd)).abs().toFixed();
        amounts.set(holder, after);
        out.push({
          ledger_index: ledger,
          tx_index: tx,
          node_index: node++,
          holder,
          clawback,
          amount_before: before,
          amount_after: after,
          counted_before: 1,
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
});
