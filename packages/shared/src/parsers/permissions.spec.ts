import { getNetworkProfile, NETWORK_NAMES } from '../network/network-profile';
import { GRANULAR_PERMISSIONS, permissionOf, transactionTypesOf } from './permissions';

const T = transactionTypesOf(getNetworkProfile('xrpl'));

describe('GRANULAR_PERMISSIONS', () => {
  it('lists the twelve of xrpl.org, 65537 to 65548, by value', () => {
    expect(GRANULAR_PERMISSIONS.map((p) => p.value)).toEqual(Array.from({ length: 12 }, (_, i) => 65537 + i));
    expect(GRANULAR_PERMISSIONS.map((p) => [p.name, p.transactionType])).toEqual([
      ['TrustlineAuthorize', 'TrustSet'],
      ['TrustlineFreeze', 'TrustSet'],
      ['TrustlineUnfreeze', 'TrustSet'],
      ['AccountDomainSet', 'AccountSet'],
      ['AccountEmailHashSet', 'AccountSet'],
      ['AccountMessageKeySet', 'AccountSet'],
      ['AccountTransferRateSet', 'AccountSet'],
      ['AccountTickSizeSet', 'AccountSet'],
      ['PaymentMint', 'Payment'],
      ['PaymentBurn', 'Payment'],
      ['MPTokenIssuanceLock', 'MPTokenIssuanceSet'],
      ['MPTokenIssuanceUnlock', 'MPTokenIssuanceSet'],
    ]);
  });

  it('narrows only transaction types of the xrpl definitions, and no name is a transaction type', () => {
    for (const p of GRANULAR_PERMISSIONS) {
      expect(T[p.transactionType]).toBeGreaterThanOrEqual(0);
      expect(T[p.name]).toBeUndefined();
    }
  });
});

describe('transactionTypesOf', () => {
  it('is the TRANSACTION_TYPES of the profile definitions', () => {
    expect(T.Payment).toBe(0);
    expect(T.OfferCreate).toBe(7);
    expect(T.DelegateSet).toBe(64);
    expect(transactionTypesOf(getNetworkProfile('xrpl-testnet')).DelegateSet).toBe(64);
  });

  it('has no DelegateSet on Xahau, where the amendment does not exist', () => {
    for (const name of ['xahau', 'xahau-testnet'] as const) {
      const types = transactionTypesOf(getNetworkProfile(name));
      expect(types.Payment).toBe(0);
      expect(types.DelegateSet).toBeUndefined();
    }
  });

  it('is empty when the profile has no definitions, and for every network it is a plain table of integers', () => {
    const without = { ...getNetworkProfile('xrpl'), definitionsFallback: () => undefined };
    expect(transactionTypesOf(without)).toEqual({});
    for (const name of NETWORK_NAMES) {
      const types = transactionTypesOf(getNetworkProfile(name));
      expect(Object.keys(types).length).toBeGreaterThan(50);
      expect(Object.values(types).every((code) => Number.isInteger(code))).toBe(true);
    }
  });
});

describe('permissionOf', () => {
  it('names a transaction-type permission given as a name, which is how the node writes it', () => {
    expect(permissionOf('Payment', T)).toEqual({ permission: 'Payment', kind: 'transaction' });
    expect(permissionOf('OfferCreate', T)).toEqual({ permission: 'OfferCreate', kind: 'transaction' });
  });

  it('keeps a name it does not know as a transaction permission (the node writes the names it knows)', () => {
    expect(permissionOf('SomeNewType', T)).toEqual({ permission: 'SomeNewType', kind: 'transaction' });
    expect(permissionOf('Payment', {})).toEqual({ permission: 'Payment', kind: 'transaction' });
  });

  it('names a transaction-type permission given as a number: the type code plus one', () => {
    expect(permissionOf(T.Payment + 1, T)).toEqual({ permission: 'Payment', kind: 'transaction' });
    expect(permissionOf(T.OfferCreate + 1, T)).toEqual({ permission: 'OfferCreate', kind: 'transaction' });
    expect(permissionOf(T.DelegateSet + 1, T)).toEqual({ permission: 'DelegateSet', kind: 'transaction' });
    expect(permissionOf(String(T.Payment + 1), T)).toEqual({ permission: 'Payment', kind: 'transaction' });
  });

  it('names a granular permission given as a value or a name, with the transaction type it narrows', () => {
    expect(permissionOf(65538, T)).toEqual({
      permission: 'TrustlineFreeze',
      kind: 'granular',
      transaction_type: 'TrustSet',
    });
    expect(permissionOf('TrustlineAuthorize', T)).toEqual({
      permission: 'TrustlineAuthorize',
      kind: 'granular',
      transaction_type: 'TrustSet',
    });
    expect(permissionOf('65541', T)).toEqual({
      permission: 'AccountEmailHashSet',
      kind: 'granular',
      transaction_type: 'AccountSet',
    });
    expect(permissionOf(65548, {})).toEqual({
      permission: 'MPTokenIssuanceUnlock',
      kind: 'granular',
      transaction_type: 'MPTokenIssuanceSet',
    });
  });

  it('resolves all twelve granular permissions by value and by name to the same answer', () => {
    for (const p of GRANULAR_PERMISSIONS) {
      const expected = { permission: p.name, kind: 'granular', transaction_type: p.transactionType };
      expect(permissionOf(p.value, T)).toEqual(expected);
      expect(permissionOf(p.name, T)).toEqual(expected);
    }
  });

  it('keeps any other number as unknown, with the number as the permission', () => {
    expect([permissionOf(70001, T), permissionOf('70001', T)]).toEqual([
      { permission: '70001', kind: 'unknown' },
      { permission: '70001', kind: 'unknown' },
    ]);
    expect(permissionOf(65549, T)).toEqual({ permission: '65549', kind: 'unknown' });
  });

  it('does not take 0 (full permissions) for the transaction type "Invalid", whose code is -1', () => {
    expect(T.Invalid).toBe(-1);
    expect(permissionOf(0, T)).toEqual({ permission: '0', kind: 'unknown' });
    expect(permissionOf('0', T)).toEqual({ permission: '0', kind: 'unknown' });
  });

  it('reads a number against the transaction codes of the network it is given: 65 is DelegateSet on XRPL only', () => {
    const xahau = transactionTypesOf(getNetworkProfile('xahau'));
    expect(permissionOf(T.DelegateSet + 1, T)).toEqual({ permission: 'DelegateSet', kind: 'transaction' });
    expect(permissionOf(T.DelegateSet + 1, xahau)).toEqual({
      permission: 'MPTokenIssuanceDestroy',
      kind: 'transaction',
    });
  });

  it('is unknown for a number that is no transaction code plus one on the network', () => {
    expect(Object.values(T)).not.toContain(9998);
    expect(permissionOf(9999, T)).toEqual({ permission: '9999', kind: 'unknown' });
    expect(permissionOf(T.Payment + 1, {})).toEqual({ permission: '1', kind: 'unknown' });
  });

  it('keeps a number that is not an integer, and a digit string beyond 2^53, as unknown', () => {
    expect(permissionOf(1.5, T)).toEqual({ permission: '1.5', kind: 'unknown' });
    expect(permissionOf(NaN, T)).toEqual({ permission: 'NaN', kind: 'unknown' });
    expect(permissionOf('123456789012345678901234567890', T)).toEqual({
      permission: '123456789012345678901234567890',
      kind: 'unknown',
    });
  });

  it('keeps a value that is neither a number nor a string as unknown', () => {
    expect(permissionOf(null, T)).toEqual({ permission: 'null', kind: 'unknown' });
    expect(permissionOf(undefined, T)).toEqual({ permission: 'undefined', kind: 'unknown' });
  });
});
