import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { TrustLineStatesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import {
  EDGE_AMOUNTS,
  generatedAmount,
  generatedLowSideLine,
  seededRandom,
  stateRowsOf,
} from '../src/test-utils/token-history-cases';
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
