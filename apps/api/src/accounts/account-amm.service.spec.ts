import { AMM_POOLS_CHUNK, ClickHouseService, Table } from '@gatehub/data-api-shared';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { AccountAmmService } from './account-amm.service';

/**
 * The positions of an account against a ClickHouse stand-in that answers by the table a statement names: what is asked
 * (which tables, how many pools at a time, with which bounds) is the service's, what comes back is made here.
 */

const ACCOUNT = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const poolAt = (n: number): string => `rPool${String(n).padStart(5, '0')}`;
const lp = (n: number): string => `03${n.toString(16).toUpperCase().padStart(38, '0')}`;

interface Line {
  currency: string;
  counterparty: string;
  balance: string;
}
interface Pool {
  amm_account: string;
  newest_deleted?: number;
  filled_reserve_base?: string | null;
  filled_reserve_counter?: string | null;
  filled_lp_supply?: string | null;
  filled_lp_currency?: string | null;
}

function build(lines: Line[], pools: Pool[], ledgers: { latest?: number; at?: number } = { latest: 500, at: 400 }) {
  const calls: { sql: string; params: Record<string, unknown> }[] = [];
  const ch = {
    query: jest.fn((sql: string, params: Record<string, unknown> = {}) => {
      calls.push({ sql, params });
      if (sql.includes(`FROM ${Table.BalanceChanges}`)) return Promise.resolve(lines);
      if (sql.includes(`FROM ${Table.AmmPoolStates}`)) {
        const asked = (params.accounts as string[] | undefined) ?? [];
        return Promise.resolve(
          pools
            .filter((p) => asked.includes(p.amm_account))
            .map((p) => ({
              asset_base_currency: 'XRP',
              asset_base_issuer: '',
              asset_counter_currency: 'USD',
              asset_counter_issuer: ACCOUNT,
              newest_ledger: 1,
              newest_close: 1,
              newest_deleted: 0,
              now_ms: 1,
              filled_reserve_base: '100',
              filled_reserve_counter: '10',
              filled_lp_supply: '1000',
              filled_lp_currency: null,
              ...p,
            })),
        );
      }
      return Promise.resolve([]);
    }),
  };
  const ranges = {
    latest: jest.fn(() => Promise.resolve(ledgers.latest)),
    ledgerAtOrBefore: jest.fn(() => Promise.resolve(ledgers.at)),
  };
  const service = new AccountAmmService(ch as unknown as ClickHouseService, ranges as unknown as LedgerRangeResolver);
  return { service, calls, ch, ranges };
}

describe('AccountAmmService.positions', () => {
  it('is empty, and reads nothing, when no ledger closed at or before the date', async () => {
    const { service, calls, ranges } = build([], [], { at: undefined });
    expect(await service.positions(ACCOUNT, new Date('2000-01-01'))).toEqual([]);
    expect(ranges.ledgerAtOrBefore).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    const empty = build([], [], { latest: undefined });
    expect(await empty.service.positions(ACCOUNT)).toEqual([]);
    expect(empty.calls).toHaveLength(0);
  });

  it('resolves the date to the ledger of the date, and no date to the newest committed ledger', async () => {
    const dated = build([], [], { latest: 500, at: 400 });
    await dated.service.positions(ACCOUNT, new Date('2025-01-01'));
    expect(dated.ranges.latest).not.toHaveBeenCalled();
    expect(dated.calls[0].params).toMatchObject({ account: ACCOUNT, ledger: 400 });
    const now = build([], [], { latest: 500, at: 400 });
    await now.service.positions(ACCOUNT);
    expect(now.ranges.ledgerAtOrBefore).not.toHaveBeenCalled();
    expect(now.calls[0].params).toMatchObject({ account: ACCOUNT, ledger: 500 });
  });

  it('reads the lines of the account up to the ledger, the currencies of LP tokens only, with the pattern bound', async () => {
    const { service, calls } = build([], []);
    await service.positions(ACCOUNT);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    expect(sql).toContain(`FROM ${Table.BalanceChanges}`);
    expect(sql).toContain('account = {account:String}');
    expect(sql).toContain('ledger_index <= {ledger:UInt32}');
    expect(sql).toContain('match(currency, {lp_currency:String})');
    expect(sql).toContain('argMax(final_balance, (ledger_index, tx_index, node_index))');
    expect(sql).not.toMatch(/\bFINAL\b/i);
    const pattern = new RegExp(params.lp_currency as string);
    expect(pattern.test(lp(1))).toBe(true);
    for (const other of [
      'USD',
      '04' + 'A'.repeat(38),
      '03' + 'A'.repeat(36),
      '03' + 'A'.repeat(39),
      '03' + 'G'.repeat(38),
    ]) {
      expect([other, pattern.test(other)]).toEqual([other, false]);
    }
  });

  it('reads no pool at all for an account with no LP line, or whose lines are all at 0', async () => {
    const none = build([], []);
    expect(await none.service.positions(ACCOUNT)).toEqual([]);
    expect(none.calls.some((c) => c.sql.includes(Table.AmmPoolStates))).toBe(false);
    const zero = build(
      [
        { currency: lp(1), counterparty: poolAt(1), balance: '0' },
        { currency: lp(2), counterparty: poolAt(2), balance: '0.000' },
      ],
      [{ amm_account: poolAt(1), filled_lp_currency: lp(1) }],
    );
    expect(await zero.service.positions(ACCOUNT)).toEqual([]);
    expect(zero.calls.some((c) => c.sql.includes(Table.AmmPoolStates))).toBe(false);
  });

  it('reads the pools of the lines once each, sorted, in batches of the size of the fill-forward', async () => {
    const count = 2 * AMM_POOLS_CHUNK + 5;
    const lines = Array.from({ length: count }, (_, i) => ({
      currency: lp(i),
      counterparty: poolAt(count - i),
      balance: '1',
    }));
    const { service, calls } = build(lines, []);
    await service.positions(ACCOUNT);
    const batches = calls
      .filter((c) => c.sql.includes(Table.AmmPoolStates) && Array.isArray(c.params.accounts))
      .map((c) => c.params.accounts as string[]);
    expect(batches.map((b) => b.length)).toEqual([AMM_POOLS_CHUNK, AMM_POOLS_CHUNK, 5]);
    const all = batches.flat();
    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(count);
    // every batch is read up to the ledger, from a window before it
    for (const c of calls.filter((x) => x.sql.includes(Table.AmmPoolStates) && Array.isArray(x.params.accounts))) {
      expect(c.params.fill_up_to).toBe(500);
      expect(Number(c.params.fill_from)).toBeLessThan(500);
    }
  });

  it('keeps the lines whose pool names the line currency, not a pool without a state, another code, a deleted pool or an empty supply', async () => {
    const lines = [
      { currency: lp(1), counterparty: poolAt(1), balance: '10' },
      { currency: lp(2), counterparty: poolAt(2), balance: '10' },
      { currency: lp(3), counterparty: poolAt(3), balance: '10' },
      { currency: lp(4), counterparty: poolAt(4), balance: '10' },
      { currency: lp(5), counterparty: poolAt(5), balance: '10' },
      { currency: lp(6), counterparty: poolAt(6), balance: '10' },
    ];
    const pools: Pool[] = [
      { amm_account: poolAt(1), filled_lp_currency: lp(1) },
      { amm_account: poolAt(2), filled_lp_currency: lp(99) },
      { amm_account: poolAt(3), filled_lp_currency: lp(3), newest_deleted: 1 },
      { amm_account: poolAt(4), filled_lp_currency: lp(4), filled_lp_supply: '0' },
      { amm_account: poolAt(5), filled_lp_currency: null },
      // pool 6 has no state at all
    ];
    const { service } = build(lines, pools);
    expect(await service.positions(ACCOUNT)).toEqual([
      { pool: poolAt(1), lp_currency: lp(1), lp_balance: '10', share: '0.01', base_amount: '1', counter_amount: '0.1' },
    ]);
  });

  it('sorts the positions by pool', async () => {
    const lines = [
      { currency: lp(2), counterparty: poolAt(2), balance: '1' },
      { currency: lp(1), counterparty: poolAt(3), balance: '1' },
      { currency: lp(3), counterparty: poolAt(1), balance: '1' },
    ];
    const pools = [
      { amm_account: poolAt(1), filled_lp_currency: lp(3) },
      { amm_account: poolAt(2), filled_lp_currency: lp(2) },
      { amm_account: poolAt(3), filled_lp_currency: lp(1) },
    ];
    const { service } = build(lines, pools);
    expect((await service.positions(ACCOUNT)).map((p) => p.pool)).toEqual([poolAt(1), poolAt(2), poolAt(3)]);
  });
});
