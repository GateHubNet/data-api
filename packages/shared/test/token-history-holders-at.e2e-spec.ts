import BigNumber from 'bignumber.js';
import { TokenKey } from '../src/aggregate/token-rules';
import { nextPassAccounts } from '../src/aggregate/tokens.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { TokenCheckpointHeadsRow, TokenCheckpointsRow, TokenHolderChangesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { writeChangesBatch } from '../src/token-history/build/changes-pass';
import { checkpointAt, HolderAt, holdersAt, holdersAtSql, totalsAt } from '../src/token-history/holders-at';
import { orderKeyOf } from '../src/token-history/order-key';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { bruteForceLines, lineMapKey, seedTokenHistoryWorld, TokenHistoryWorld, tokenMapKey } from './tokens-world';

const CTX = parseContextFor(getNetworkProfile('xrpl'));
const G = 1;

/** What a holder of the brute force says, in the terms of `HolderAt`. */
interface Expected {
  holder: string;
  amount: string;
  limit: string;
  frozen: boolean;
  authorized: boolean;
}

const asExpected = (h: HolderAt): Expected => ({
  holder: h.holder,
  amount: h.amount,
  limit: h.limit,
  frozen: h.frozen,
  authorized: h.authorized,
});
const byHolder = (a: { holder: string }, b: { holder: string }) => (a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0);

/** The counting lines of `token` at `n`, by the brute force over `trust_line_states` (`bruteForceLines`). */
async function bruteHolders(ch: ClickHouseService, token: TokenKey, n: number): Promise<Expected[]> {
  const prefix = `${tokenMapKey(token)} `;
  const out: Expected[] = [];
  for (const [key, { line }] of await bruteForceLines(ch, n)) {
    if (!key.startsWith(prefix)) continue;
    out.push({
      holder: line.holder,
      amount: line.balance,
      limit: line.limit,
      frozen: line.frozen === 1,
      authorized: line.authorized === 1,
    });
  }
  expect(out.every((e) => lineMapKey(token, e.holder) === `${prefix}${e.holder}`)).toBe(true);
  return out.sort(byHolder);
}

describe('holders and totals at a ledger (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let ch: ClickHouseService;
  let world: TokenHistoryWorld;
  let usd: TokenKey;
  let cp: number;

  async function fresh(name: string): Promise<ClickHouseService> {
    const config = { ...container.config, database: name };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  beforeAll(async () => {
    container = await startClickHouse();
    ch = await fresh('token_history_holders_at');
    world = await seedTokenHistoryWorld(ch, new LedgerWriter(ch, CTX));
    let after = '';
    for (;;) {
      const accounts = await nextPassAccounts(ch, after, 4);
      if (accounts.length === 0) break;
      await writeChangesBatch(ch, G, accounts, world.first, world.head, { coverageComplete: true });
      after = accounts[accounts.length - 1];
    }
    usd = { issuer: world.gate, currency: world.usd };

    // a checkpoint of gate's USD at first + 2, written by hand from the brute force and the change log
    cp = world.first + 2;
    const lines = await bruteHolders(ch, usd, cp);
    const changes = await ch.query<{ holder: string; ledger_index: number; counted_after: number }>(
      `SELECT holder, ledger_index, counted_after FROM ${Table.TokenHolderChanges}
        WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String} AND ledger_index <= {cp:UInt32}`,
      { g: G, ...usd, cp },
    );
    const rows: TokenCheckpointsRow[] = lines.map((l) => {
      const mine = changes.filter((c) => c.holder === l.holder);
      const key = orderKeyOf(l.amount, 'issued');
      return {
        generation: G,
        issuer: usd.issuer,
        currency: usd.currency,
        checkpoint_ledger: cp,
        holder: l.holder,
        amount: l.amount,
        escrowed: '0',
        limit: l.limit,
        frozen: l.frozen ? 1 : 0,
        authorized: l.authorized ? 1 : 0,
        order_exp: key.exp,
        order_mant: key.mant.toString(),
        first_ledger: Math.min(...mine.filter((c) => c.counted_after === 1).map((c) => c.ledger_index)),
        last_ledger: Math.max(...mine.map((c) => c.ledger_index)),
      };
    });
    await ch.insert(Table.TokenCheckpoints, rows);
    const head: TokenCheckpointHeadsRow = {
      generation: G,
      issuer: usd.issuer,
      currency: usd.currency,
      checkpoint_ledger: cp,
      supply: lines.reduce((s, l) => s.plus(l.amount), new BigNumber(0)).toFixed(),
      holders: String(lines.filter((l) => l.amount !== '0').length),
      trust_lines: String(lines.length),
      changes_since: String(changes.length),
      first_ledger: Math.min(...changes.map((c) => c.ledger_index)),
    };
    await ch.insert(Table.TokenCheckpointHeads, [head]);
  }, 180_000);

  afterAll(async () => {
    for (const s of services) await s.close();
    await container?.container.stop();
  });

  it('holdersAt equals the brute force at cp-1, cp and cp+1', async () => {
    expect(await checkpointAt(ch, G, usd, cp - 1)).toBe(0);
    expect(await checkpointAt(ch, G, usd, cp)).toBe(cp);
    expect(await checkpointAt(ch, G, usd, world.head)).toBe(cp);
    for (const n of [cp - 1, cp, cp + 1, world.later.first, world.head]) {
      const got = (await holdersAt(ch, G, usd, n)).sort(byHolder);
      expect({ n, holders: got.map(asExpected) }).toEqual({ n, holders: await bruteHolders(ch, usd, n) });
      for (const h of got) {
        expect(h.counted).toBe(true);
        expect(h.first_ledger).toBeLessThanOrEqual(h.last_ledger);
        expect(h.last_ledger).toBeLessThanOrEqual(n);
        expect({ exp: h.exp, mant: h.mant }).toEqual({
          exp: orderKeyOf(h.amount, 'issued').exp,
          mant: orderKeyOf(h.amount, 'issued').mant.toString(),
        });
      }
    }
  });

  it('carries first and last activity across the checkpoint', async () => {
    const before = new Map((await holdersAt(ch, G, usd, cp)).map((h) => [h.holder, h]));
    const after = await holdersAt(ch, G, usd, world.head);
    // the holders whose line stopped counting after the checkpoint and counts again
    const stopped = new Set(
      (
        await ch.query<{ holder: string }>(
          `SELECT DISTINCT holder FROM ${Table.TokenHolderChanges}
            WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
              AND ledger_index > {cp:UInt32} AND counted_after = 0`,
          { g: G, ...usd, cp },
        )
      ).map((r) => r.holder),
    );
    for (const h of after) {
      const was = before.get(h.holder);
      // a line that kept counting keeps the start of its run; one that stopped and came back starts a new run
      if (was !== undefined && !stopped.has(h.holder)) expect(h.first_ledger).toBe(was.first_ledger);
      expect(h.last_ledger).toBeGreaterThanOrEqual(was?.last_ledger ?? 0);
    }
    // the line that turned round (250 became -4) and back (7) counts again from the ledger it came back in
    expect(stopped.has(world.later.turnedRound)).toBe(true);
    expect(after.find((h) => h.holder === world.later.turnedRound)?.first_ledger).toBe(world.later.first + 3);
    expect(before.get(world.later.turnedRound)?.first_ledger).toBe(world.first);
    // the holder changed twice in the second batch: its last activity is the second change
    expect(after.find((h) => h.holder === world.later.changedTwice)?.last_ledger).toBe(world.later.first + 2);
  });

  it('totalsAt equals the sums of the brute force', async () => {
    for (const n of [cp - 1, cp, cp + 1, world.head]) {
      const lines = await bruteHolders(ch, usd, n);
      const totals = await totalsAt(ch, G, usd, n);
      expect({ n, supply: totals.supply, holders: totals.holders, trust_lines: totals.trust_lines }).toEqual({
        n,
        supply: lines.reduce((s, l) => s.plus(l.amount), new BigNumber(0)).toFixed(),
        holders: lines.filter((l) => l.amount !== '0').length,
        trust_lines: lines.length,
      });
      expect(totals.first_ledger).toBe(world.first);
      expect(totals.last_ledger).toBeLessThanOrEqual(n);
    }
    // a token whose amount the decimal cannot hold (1e40 of HUG) is summed in BigNumber, exactly
    const hug = { issuer: world.nostate, currency: world.huge };
    expect((await totalsAt(ch, G, hug, world.head)).supply).toBe(new BigNumber('1e40').plus(5).toFixed());
  });

  it("holdersAt before the token's first change is empty", async () => {
    expect(await holdersAt(ch, G, usd, world.first - 1)).toEqual([]);
    const fresh = { issuer: world.plain, currency: world.later.newCurrency };
    expect(await holdersAt(ch, G, fresh, world.later.first - 1)).toEqual([]);
    expect(await totalsAt(ch, G, fresh, world.later.first - 1)).toEqual({ supply: '0', holders: 0, trust_lines: 0 });
    expect(await holdersAt(ch, G, fresh, world.later.first)).toHaveLength(1);
  });

  it('holders filter reads only the named holders', async () => {
    const all = await bruteHolders(ch, usd, world.head);
    const named = [all[0].holder, all[3].holder, 'rNobodyHoldsThisToken000000000000'];
    const got = (await holdersAt(ch, G, usd, world.head, { holders: named })).sort(byHolder);
    expect(got.map(asExpected)).toEqual(all.filter((l) => named.includes(l.holder)));
  });

  it("reads at most the checkpoint's rows plus the changes after it plus 2 granules a part", async () => {
    const bulk = await fresh('token_history_holders_bound');
    const token = { issuer: 'rMiddleIssuer', currency: 'USD' };
    const change = (issuer: string, holder: string, ledger: number, amount: string): TokenHolderChangesRow => ({
      generation: G,
      issuer,
      currency: 'USD',
      ledger_index: ledger,
      tx_index: 0,
      node_index: 0,
      holder,
      close_time: 1_700_000_000,
      clawback: 0,
      amount_before: '0',
      amount_after: amount,
      counted_before: 0,
      counted_after: 1,
      before_known: 1,
      limit: '1000',
      frozen: 0,
      authorized: 0,
      escrowed: '0',
      order_exp: 0,
      order_mant: '0',
    });
    const CP = 50_000;
    // the token's 60,000 changes before the checkpoint, its 300 after, and 200,000 of two other tokens around it
    const rows: TokenHolderChangesRow[] = [];
    for (let i = 0; i < 60_000; i++) rows.push(change(token.issuer, `rH${i % 3_000}`, 1 + Math.floor(i / 2), String(i)));
    for (let i = 0; i < 300; i++) rows.push(change(token.issuer, `rH${i}`, CP + 1 + i, String(i + 7)));
    for (let i = 0; i < 100_000; i++) rows.push(change('rAboveIssuer', `rX${i}`, 1 + (i % 90_000), '1'));
    for (let i = 0; i < 100_000; i++) rows.push(change('rBelowIssuer', `rY${i}`, 1 + (i % 90_000), '1'));
    await bulk.insert(Table.TokenHolderChanges, rows);
    const checkpoint: TokenCheckpointsRow[] = Array.from({ length: 3_000 }, (_, i) => ({
      generation: G,
      issuer: token.issuer,
      currency: 'USD',
      checkpoint_ledger: CP,
      holder: `rH${i}`,
      amount: '5',
      escrowed: '0',
      limit: '1000',
      frozen: 0,
      authorized: 0,
      order_exp: -15,
      order_mant: '5000000000000000',
      first_ledger: 1,
      last_ledger: 30_000,
    }));
    await bulk.insert(Table.TokenCheckpoints, checkpoint);
    await bulk.command(`OPTIMIZE TABLE ${Table.TokenHolderChanges} FINAL`);

    const parts = async (): Promise<number> =>
      Number(
        (
          await bulk.queryOne<{ n: string }>(
            `SELECT toString(count()) AS n FROM system.parts
              WHERE database = currentDatabase() AND active AND table IN ({tables:Array(String)})`,
            { tables: [Table.TokenHolderChanges, Table.TokenCheckpoints] },
          )
        )?.n,
      );
    const readRows = async (sql: string, tag: string): Promise<number> => {
      await bulk.command('SYSTEM DROP QUERY CONDITION CACHE');
      const got = await bulk.query(sql, { g: G, ...token, cp: CP, n: CP + 1_000 }, { log_comment: tag });
      expect(got).toHaveLength(3_000);
      await bulk.command('SYSTEM FLUSH LOGS');
      const row = await bulk.queryOne<{ read: string }>(
        `SELECT toString(read_rows) AS read FROM system.query_log
          WHERE log_comment = {tag:String} AND type = 'QueryFinish' ORDER BY event_time_microseconds DESC LIMIT 1`,
        { tag },
      );
      return Number(row?.read);
    };
    const bound = 3_000 + 300 + 2 * 8_192 * (await parts());
    const sql = holdersAtSql({});
    expect(await readRows(sql, 'holders-at-bound')).toBeLessThanOrEqual(bound);
    // the mutant reads the token's changes before the checkpoint too
    const mutant = sql.replace('ledger_index > {cp:UInt32}', '1');
    expect(mutant).not.toBe(sql);
    expect(await readRows(mutant, 'holders-at-mutant')).toBeGreaterThan(bound);
  });
});
