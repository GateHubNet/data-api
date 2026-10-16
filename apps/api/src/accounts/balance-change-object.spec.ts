import { BALANCE_CHANGE_COLUMNS, StoredBalanceChange, toBalanceChangeObject } from './balance-change-object';

const COUNTERPARTY = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

/** A native fee row, as `balance_changes` stores it. Frozen, as an input must not be changed. */
const FEE: StoredBalanceChange = Object.freeze({
  ledger_index: 11119603,
  tx_index: 4,
  node_index: -1,
  tx_hash: 'A'.repeat(64),
  close_time: 1_421_260_040,
  currency: 'XRP',
  counterparty: '',
  amount_change: '-0.015',
  final_balance: '99.985',
  change_type: 'transaction_cost',
  escrow_counterparty: null,
  escrow_balance_change: null,
  paychannel_counterparty: null,
  paychannel_fund_change: null,
  paychannel_fund_final_balance: null,
  paychannel_final_balance: null,
  paychannel_balance_change: null,
});

describe('BALANCE_CHANGE_COLUMNS', () => {
  it('reads the columns of a change, the close time as unix seconds, and neither the account nor the client', () => {
    const columns = BALANCE_CHANGE_COLUMNS.split(', ');
    expect(columns).toContain('toUnixTimestamp(close_time) AS close_time');
    for (const column of ['account', 'client', 'final_balance_f']) expect(columns).not.toContain(column);
    expect(columns).toHaveLength(Object.keys(FEE).length);
  });
});

describe('toBalanceChangeObject', () => {
  it('has the keys of the original in its order: d family, then f family, each sorted by name', () => {
    const full: StoredBalanceChange = {
      ...FEE,
      node_index: 3,
      counterparty: COUNTERPARTY,
      escrow_counterparty: 'rEscrow',
      escrow_balance_change: '100',
      paychannel_counterparty: 'rChannel',
      paychannel_fund_change: '-5',
      paychannel_fund_final_balance: '30',
      paychannel_final_balance: '8.5',
      paychannel_balance_change: '-0.5',
    };
    expect(Object.keys(toBalanceChangeObject(full))).toEqual([
      'amount_change',
      'escrow_balance_change',
      'final_balance',
      'node_index',
      'paychannel_balance_change',
      'paychannel_final_balance',
      'paychannel_fund_change',
      'paychannel_fund_final_balance',
      'tx_index',
      'change_type',
      'counterparty',
      'currency',
      'escrow_counterparty',
      'executed_time',
      'ledger_index',
      'paychannel_counterparty',
      'tx_hash',
    ]);
  });

  it('serves the amounts as stored, the time as YYYY-MM-DDTHH:mm:ssZ, and leaves out what the fee row does not have', () => {
    expect(toBalanceChangeObject(FEE)).toEqual({
      amount_change: '-0.015',
      final_balance: '99.985',
      tx_index: 4,
      change_type: 'transaction_cost',
      currency: 'XRP',
      executed_time: '2015-01-14T18:27:20Z',
      ledger_index: 11119603,
      tx_hash: 'A'.repeat(64),
    });
  });

  it('keeps node_index 0 and every other node, and omits only the fee row (-1)', () => {
    expect(toBalanceChangeObject({ ...FEE, node_index: 0 })).toHaveProperty('node_index', 0);
    expect(toBalanceChangeObject({ ...FEE, node_index: 12 })).toHaveProperty('node_index', 12);
    expect(toBalanceChangeObject(FEE)).not.toHaveProperty('node_index');
  });

  it('serves the counterparty of an issued currency and not the empty one of the native currency', () => {
    expect(toBalanceChangeObject({ ...FEE, currency: 'USD', counterparty: COUNTERPARTY })).toHaveProperty(
      'counterparty',
      COUNTERPARTY,
    );
    expect(toBalanceChangeObject(FEE)).not.toHaveProperty('counterparty');
  });

  it('leaves the change type out when there is none (a change of GenesisMint, Cron, ...)', () => {
    expect(toBalanceChangeObject({ ...FEE, node_index: 1, change_type: '' })).not.toHaveProperty('change_type');
    expect(toBalanceChangeObject({ ...FEE, change_type: 'exchange' })).toHaveProperty('change_type', 'exchange');
  });

  it('serves the escrow and payment channel fields the row has, whatever their value, and only those', () => {
    const served = toBalanceChangeObject({
      ...FEE,
      escrow_counterparty: 'rEscrow',
      escrow_balance_change: '0',
      paychannel_fund_change: '0',
    });
    expect(served).toMatchObject({
      escrow_counterparty: 'rEscrow',
      escrow_balance_change: '0',
      paychannel_fund_change: '0',
    });
    for (const key of [
      'paychannel_counterparty',
      'paychannel_fund_final_balance',
      'paychannel_final_balance',
      'paychannel_balance_change',
    ]) {
      expect(served).not.toHaveProperty(key);
    }
  });

  it('does not serve the account, the client or the shadow, even when the row has them', () => {
    const wide = { ...FEE, account: 'rAccount', client: 'rt1.2.1', final_balance_f: 99.985 };
    const served = toBalanceChangeObject(wide);
    for (const key of ['account', 'client', 'final_balance_f', 'close_time']) expect(served).not.toHaveProperty(key);
  });
});
