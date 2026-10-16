import { StoredExchange, toCsvRow, toExchangeObject } from '../exchanges/exchange-object';
import {
  ACCOUNT_EXCHANGE_COLUMNS,
  StoredAccountExchange,
  toAccountCsvRow,
  toAccountExchangeObject,
} from './account-exchange-object';

const ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

/** USD+ISSUER (base) for XRP (counter), as `account_exchanges` stores the pair. Frozen, as an input must not be changed. */
const STORED: StoredAccountExchange = Object.freeze({
  base_currency: 'USD',
  base_issuer: ISSUER,
  counter_currency: 'XRP',
  counter_issuer: '',
  ledger_index: 11119603,
  tx_index: 12,
  node_index: 4,
  tx_hash: 'A'.repeat(64),
  close_time: 1_421_260_040,
  base_amount: '0.5',
  counter_amount: '125',
  rate: '250',
  buyer: 'rBuyer',
  seller: 'rSeller',
  taker: 'rTaker',
  provider: 'rProvider',
  offer_sequence: 59207,
  autobridged_currency: null,
  autobridged_issuer: null,
  tx_type: 'OfferCreate',
  client: null,
});

describe('ACCOUNT_EXCHANGE_COLUMNS', () => {
  it('reads the columns of an exchange and the client', () => {
    const columns = ACCOUNT_EXCHANGE_COLUMNS.split(', ');
    expect(columns).toContain('client');
    expect(columns).toContain('toUnixTimestamp(close_time) AS close_time');
    // never the account, the Float64 shadows or the wide row's other columns
    for (const column of ['account', 'base_amount_f', 'counter_amount_f', 'rate_f']) {
      expect(columns).not.toContain(column);
    }
  });
});

describe('toAccountExchangeObject', () => {
  it('has the keys of the original in its order: d family, then f family with the pair among them, each sorted', () => {
    const full: StoredAccountExchange = {
      ...STORED,
      autobridged_currency: 'EUR',
      autobridged_issuer: ISSUER,
      counter_issuer: ISSUER,
      client: 'rt1.2.1',
    };
    expect(Object.keys(toAccountExchangeObject(full))).toEqual([
      'base_amount',
      'counter_amount',
      'node_index',
      'rate',
      'tx_index',
      'autobridged_currency',
      'autobridged_issuer',
      'base_currency',
      'base_issuer',
      'buyer',
      'client',
      'counter_currency',
      'counter_issuer',
      'executed_time',
      'ledger_index',
      'offer_sequence',
      'provider',
      'seller',
      'taker',
      'tx_hash',
      'tx_type',
    ]);
  });

  it('is the exchange of /v2/exchanges, with the client when the row has one', () => {
    const plain = toAccountExchangeObject(STORED);
    expect(plain).toEqual(toExchangeObject(STORED as StoredExchange));
    expect(plain).not.toHaveProperty('client');
    const withClient = toAccountExchangeObject({ ...STORED, client: 'rt1.2.1' });
    expect(withClient).toEqual({ ...toExchangeObject(STORED as StoredExchange), client: 'rt1.2.1' });
  });

  it('inverts as /v2/exchanges does: base and counter, buyer and seller swap and the rate is 1/rate', () => {
    const inverted = toAccountExchangeObject({ ...STORED, client: 'x' }, true);
    expect(inverted).toEqual({ ...toExchangeObject(STORED as StoredExchange, true), client: 'x' });
    expect(inverted).toMatchObject({
      base_currency: 'XRP',
      counter_currency: 'USD',
      counter_issuer: ISSUER,
      base_amount: '125',
      counter_amount: '0.5',
      buyer: 'rSeller',
      seller: 'rBuyer',
      rate: '0.0040000000',
    });
    expect(inverted).not.toHaveProperty('base_issuer');
  });

  it('leaves the issuer of the native currency, and the autobridged fields it does not have, out', () => {
    const served = toAccountExchangeObject(STORED);
    expect(served).not.toHaveProperty('counter_issuer');
    expect(served).not.toHaveProperty('autobridged_currency');
    expect(served).not.toHaveProperty('autobridged_issuer');
  });

  it('does not change its input', () => {
    expect(() => toAccountExchangeObject(STORED, true)).not.toThrow();
    expect(STORED.client).toBeNull();
  });
});

describe('toAccountCsvRow', () => {
  it('is the row of /v2/exchanges: every column in its order, an empty cell where the exchange has none', () => {
    const row = toAccountCsvRow(toAccountExchangeObject(STORED));
    expect(row).toEqual(toCsvRow(toExchangeObject(STORED as StoredExchange)));
    expect(Object.keys(row)).toEqual(Object.keys(toCsvRow(toExchangeObject(STORED as StoredExchange))));
    expect(row).not.toHaveProperty('client');
  });

  it('adds the client as the last column when the exchange has one', () => {
    const row = toAccountCsvRow(toAccountExchangeObject({ ...STORED, client: 'rt1.2.1' }));
    expect(Object.keys(row).at(-1)).toBe('client');
    expect(row.client).toBe('rt1.2.1');
  });
});
