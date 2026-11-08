import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { TokenHolderChangesRow, TrustLineStatesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { exactSumColumns } from '../src/query/decimal';
import {
  EDGE_AMOUNTS,
  generatedAmount,
  generatedLowSideLine,
  seededRandom,
  stateRowsOf,
} from '../src/test-utils/token-history-cases';
import { ChangeAmounts, FLOWS_BY_TX_SQL, flowsOfTransaction } from '../src/token-history/flows';
import { orderKeyOf } from '../src/token-history/order-key';
import { issuedSideOf } from '../src/token-history/token-side';
import { ISSUED_SIDE_COLUMNS, ISSUED_SIDE_KEEP, orderKeySql } from '../src/token-history/token-side.sql';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The SQL forms of the token history's rules (issuer analytics, Tasks 3 and 4) against their TypeScript oracles, on a real
 * ClickHouse: the token side of a `trust_line_states` row and the order key, run over generated rows.
 */
describe('the token history SQL rules (e2e)', () => {
  let container: StartedClickHouse;
  let ch: ClickHouseService;

  beforeAll(async () => {
    container = await startClickHouse();
    const config = { ...container.config, database: 'token_history_sql_rules' };
    await runMigrations({ config, log: () => undefined });
    ch = new ClickHouseService(config);
  }, 180_000);

  afterAll(async () => {
    await ch?.close();
    await container?.container.stop();
  });

  it('ISSUED_SIDE_COLUMNS agrees with issuedSideOf on 5,000 generated rows', async () => {
    const rnd = seededRandom(3);
    const rows: TrustLineStatesRow[] = [];
    for (let i = 0; i < 2_500; i++) {
      const line = generatedLowSideLine(rnd, 1_000 + i);
      for (const side of stateRowsOf(line)) {
        rows.push({
          ...side,
          ledger_index: line.ledger_index,
          tx_index: 0,
          node_index: 0,
          tx_hash: '',
          close_time: 1_700_000_000,
          limit: '0',
          no_ripple: 0,
          no_ripple_peer: 0,
          peer_authorized: 0,
          peer_freeze: 0,
          quality_in: 0,
          quality_out: 0,
          flags: 0,
        });
      }
    }
    expect(rows).toHaveLength(5_000);
    await ch.insert(Table.TrustLineStates, rows);

    const got = await ch.query<{
      ledger_index: number;
      account: string;
      issuer: string;
      holder: string;
      currency: string;
      counted: number;
      amount: string;
      limit: string;
      frozen: number;
      authorized: number;
      escrowed: string;
    }>(
      `SELECT ledger_index, account AS row_account, ${ISSUED_SIDE_COLUMNS}
         FROM ${Table.TrustLineStates}
        WHERE ${ISSUED_SIDE_KEEP}
        ORDER BY ledger_index, row_account`,
    );
    const byKey = new Map(got.map((r) => [`${r.ledger_index}|${r.issuer}`, r]));

    let kept = 0;
    const wrong: unknown[] = [];
    for (const row of rows) {
      const want = issuedSideOf(row);
      const sql = byKey.get(`${row.ledger_index}|${row.account}`);
      if (want === null) {
        if (sql !== undefined) wrong.push({ row, sql });
        continue;
      }
      kept++;
      const fromSql = sql && {
        issuer: sql.issuer,
        currency: sql.currency,
        holder: sql.holder,
        amount: sql.amount,
        counted: sql.counted === 1,
        limit: sql.limit,
        frozen: sql.frozen === 1,
        authorized: sql.authorized === 1,
        escrowed: sql.escrowed,
      };
      if (JSON.stringify(fromSql) !== JSON.stringify(want)) wrong.push({ row, want, sql: fromSql });
    }
    expect(wrong).toEqual([]);
    expect(got).toHaveLength(kept);
    // the generated rows reach every case: counting and not, a zero amount that counts, an LP currency
    expect(got.some((r) => r.counted === 1 && r.amount !== '0')).toBe(true);
    expect(got.some((r) => r.counted === 1 && r.amount === '0')).toBe(true);
    expect(got.some((r) => r.counted === 0)).toBe(true);
    expect(kept).toBeLessThan(rows.length);
  });

  it('orderKeySql agrees with orderKeyOf on the amounts of Task 2', async () => {
    const rnd = seededRandom(81);
    const amounts = [...EDGE_AMOUNTS, ...Array.from({ length: 2_000 }, () => generatedAmount(rnd))];
    amounts.push('0.1', '0.10', '1250.75', '100', '1e+21', '1.5e-30');
    const key = orderKeySql('a', 'issued');
    const got = await ch.query<{ a: string; exp: number; mant: string }>(
      `SELECT a, ${key.exp} AS exp, toString(${key.mant}) AS mant FROM (SELECT arrayJoin({amounts:Array(String)}) AS a)`,
      { amounts },
    );
    expect(got).toHaveLength(amounts.length);
    const wrong = got.filter((r) => {
      const want = orderKeyOf(r.a, 'issued');
      return r.exp !== want.exp || r.mant !== want.mant.toString();
    });
    expect(wrong).toEqual([]);
  });

  it('orderKeySql fails on 17 significant digits', async () => {
    const key = orderKeySql('a', 'issued');
    await expect(
      ch.query(`SELECT ${key.exp} AS exp, ${key.mant} AS mant FROM (SELECT {a:String} AS a)`, { a: '12345678901234567' }),
    ).rejects.toThrow(/more than 16 significant digits/);
  });

  it('exactSumColumns counts 1e-81 and 1e40 as unfit', async () => {
    const sums = async (amounts: string[]) =>
      ch.queryOne<{ s_exact: string | null; s_unfit: number }>(
        `SELECT ${exactSumColumns('a', 's')} FROM (SELECT arrayJoin({amounts:Array(String)}) AS a)`,
        { amounts },
      );
    // signed amounts and 30 places sum exactly
    expect(await sums(['1.5', '-0.25', '0.000000000000000000000000000001', '123456789012345678901234567890'])).toEqual({
      s_exact: '123456789012345678901234567891.250000000000000000000000000001',
      s_unfit: 0,
    });
    // 1e-81 (plain or with an exponent) has more than 30 places, 1e40 is at or above the limit, -1e40 too
    expect(
      await sums(['1', '1e-81', `0.${'0'.repeat(80)}1`, '1e40', `1${'0'.repeat(40)}`, '-1e40']),
    ).toMatchObject({ s_unfit: 5 });
  });

  it('FLOWS_BY_TX_SQL agrees with flowsOfTransaction on 1,000 generated transactions', async () => {
    const rnd = seededRandom(5);
    // amounts the decimal holds, and now and then one it cannot (1e-81, 1e40)
    const amount = (): string => {
      const r = rnd();
      if (r < 0.25) return '0';
      if (r < 0.28) return rnd() < 0.5 ? new BigNumber('1e-81').toFixed() : new BigNumber('1e40').toFixed();
      const digits = 1 + Math.floor(rnd() * 12);
      const mantissa = Math.floor(rnd() * 10 ** digits) + 1;
      return new BigNumber(mantissa).shiftedBy(-Math.floor(rnd() * 14)).toFixed();
    };
    const txs: Array<{ ledger: number; clawback: boolean; changes: ChangeAmounts[] }> = [];
    const rows: TokenHolderChangesRow[] = [];
    for (let t = 0; t < 1_000; t++) {
      const ledger = 10_000 + t;
      const clawback = rnd() < 0.2;
      const changes: ChangeAmounts[] = [];
      const n = 1 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) {
        const c = { before: amount(), after: amount(), beforeKnown: rnd() > 0.1 };
        changes.push(c);
        rows.push({
          generation: 1,
          issuer: 'rIssuer',
          currency: 'USD',
          ledger_index: ledger,
          tx_index: 0,
          node_index: i,
          holder: `rHolder${i}`,
          close_time: 1_700_000_000 + t,
          clawback: clawback ? 1 : 0,
          amount_before: c.before,
          amount_after: c.after,
          counted_before: 1,
          counted_after: 1,
          before_known: c.beforeKnown ? 1 : 0,
          limit: '0',
          frozen: 0,
          authorized: 0,
          escrowed: '0',
          order_exp: 0,
          order_mant: '0',
        });
      }
      txs.push({ ledger, clawback, changes });
    }
    await ch.insert(Table.TokenHolderChanges, rows);
    const got = await ch.query<{
      ledger_index: number;
      clawback: number;
      changes: number;
      unknown_before: number;
      unfit: number;
      issued: string;
      redeemed: string;
      clawed_back: string;
      transferred: string;
      transfers: number;
    }>(
      `WITH token_changes AS (SELECT * FROM ${Table.TokenHolderChanges} WHERE generation = 1)
       SELECT ledger_index, clawback, changes, unknown_before, unfit, toString(issued) AS issued, toString(redeemed) AS redeemed,
              toString(clawed_back) AS clawed_back, toString(transferred) AS transferred, transfers
         FROM (${FLOWS_BY_TX_SQL})
        ORDER BY ledger_index`,
    );
    expect(got).toHaveLength(txs.length);
    const unfitAmount = (a: string) => new BigNumber(a).decimalPlaces()! > 30 || new BigNumber(a).abs().isGreaterThanOrEqualTo('1e36');
    const wrong: unknown[] = [];
    let unfitTxs = 0;
    got.forEach((r, i) => {
      const tx = txs[i];
      const knownUnfit = tx.changes.some((c) => c.beforeKnown && (unfitAmount(c.before) || unfitAmount(c.after)));
      if ((r.unfit > 0) !== knownUnfit) wrong.push({ tx, r, knownUnfit });
      if (r.unfit > 0) {
        unfitTxs++;
        return;
      }
      const want = flowsOfTransaction(tx.changes, tx.clawback);
      const fromSql = {
        issued: r.issued,
        redeemed: r.redeemed,
        clawed_back: r.clawed_back,
        transferred: r.transferred,
        transfers: r.transfers,
        unknown_before: r.unknown_before,
      };
      if (JSON.stringify(fromSql) !== JSON.stringify(want) || r.changes !== tx.changes.length) wrong.push({ tx, r, want });
    });
    expect(wrong).toEqual([]);
    expect(unfitTxs).toBeGreaterThan(0);
    expect(unfitTxs).toBeLessThan(txs.length / 2);
  });

  it('orderKeySql of an MPT is its integer', async () => {
    const amounts = ['0', '1', '9007199254740993', '18446744073709551614'];
    const key = orderKeySql('a', 'mpt');
    const got = await ch.query<{ a: string; exp: number; mant: string }>(
      `SELECT a, ${key.exp} AS exp, toString(${key.mant}) AS mant FROM (SELECT arrayJoin({amounts:Array(String)}) AS a)`,
      { amounts },
    );
    expect(got.map((r) => [r.exp, r.mant])).toEqual(amounts.map((a) => [0, a]));
  });
});
