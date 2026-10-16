import { ACCOUNT_COLUMNS, StoredAccount, toAccountObject } from './account-object';

/** A row of `accounts_created` as `ACCOUNT_COLUMNS` reads it. Frozen, as an input must not be changed. */
const STORED: StoredAccount = Object.freeze({
  account: 'rHTaDFHJng6YVtThvv522LmJfkocBVkK6Z',
  parent: 'rJR7gjNe3DpJ7kpB4CHBxjDKfwVMpTKPpj',
  initial_balance: '1000',
  ledger_index: 1021029,
  tx_index: 0,
  tx_hash: 'E011E6D20BE1FAC7C37F2FA0D36F0811C404B118D936963051600796FF2C0CBC',
  inception: 1_370_980_880,
  genesis_balance: null,
  genesis_index: null,
});

describe('toAccountObject', () => {
  it('has the fields of accounts.js in its order, and nothing for the genesis fields while they are null', () => {
    const account = toAccountObject(STORED);
    expect(Object.keys(account)).toEqual([
      'account',
      'parent',
      'initial_balance',
      'inception',
      'ledger_index',
      'tx_hash',
    ]);
    expect(account).toEqual({
      account: 'rHTaDFHJng6YVtThvv522LmJfkocBVkK6Z',
      parent: 'rJR7gjNe3DpJ7kpB4CHBxjDKfwVMpTKPpj',
      initial_balance: '1000',
      inception: '2013-06-11T20:01:20Z',
      ledger_index: 1021029,
      tx_hash: 'E011E6D20BE1FAC7C37F2FA0D36F0811C404B118D936963051600796FF2C0CBC',
    });
  });

  it('adds genesis_balance and genesis_index, last, when the row has them', () => {
    const account = toAccountObject({ ...STORED, genesis_balance: '100000000000', genesis_index: 32570 });
    expect(Object.keys(account).slice(-2)).toEqual(['genesis_balance', 'genesis_index']);
    expect(account).toMatchObject({ genesis_balance: '100000000000', genesis_index: 32570 });
  });

  it('keeps a genesis_index of 0 and an empty-looking balance of "0": they are values', () => {
    const account = toAccountObject({ ...STORED, genesis_balance: '0', genesis_index: 0 });
    expect(account).toMatchObject({ genesis_balance: '0', genesis_index: 0 });
  });

  it('serves the balance as the stored text, the inception as YYYY-MM-DDTHH:mm:ssZ', () => {
    expect(toAccountObject({ ...STORED, initial_balance: '0.000001', inception: 0 })).toMatchObject({
      initial_balance: '0.000001',
      inception: '1970-01-01T00:00:00Z',
    });
    expect(toAccountObject({ ...STORED, inception: 4_102_444_799 }).inception).toBe('2099-12-31T23:59:59Z');
  });

  it('does not serve tx_index, which is only part of the key, and does not change its input', () => {
    expect(toAccountObject(STORED)).not.toHaveProperty('tx_index');
    expect(Object.isFrozen(STORED)).toBe(true);
    expect(Object.isFrozen(toAccountObject(STORED))).toBe(false);
  });
});

describe('ACCOUNT_COLUMNS', () => {
  it('reads the inception as unix seconds and every other column as it is', () => {
    expect(ACCOUNT_COLUMNS.split(', ')).toEqual([
      'account',
      'parent',
      'initial_balance',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'toUnixTimestamp(inception) AS inception',
      'genesis_balance',
      'genesis_index',
    ]);
  });
});
