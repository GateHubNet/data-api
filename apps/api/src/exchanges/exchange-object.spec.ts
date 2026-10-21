import { EXCHANGE_COLUMNS, EXCHANGE_CSV_COLUMNS, StoredExchange, toCsvRow, toExchangeObject } from './exchange-object';

const ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

/** USD+ISSUER (base) for XRP (counter), as `exchanges` stores the pair. Frozen, as an input must not be changed. */
const STORED: StoredExchange = Object.freeze({
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
  amm_account: '',
  autobridged_currency: null,
  autobridged_issuer: null,
  tx_type: 'OfferCreate',
});

describe('toExchangeObject', () => {
  it('has the fields of the original in its order: d family, f family, then the pair', () => {
    expect(Object.keys(toExchangeObject(STORED))).toEqual([
      'base_amount',
      'counter_amount',
      'node_index',
      'rate',
      'tx_index',
      'buyer',
      'executed_time',
      'ledger_index',
      'offer_sequence',
      'provider',
      'seller',
      'taker',
      'tx_hash',
      'tx_type',
      'base_currency',
      'base_issuer',
      'counter_currency',
    ]);
  });

  it('serves the amounts as stored, the rate to 8 digits and the time as YYYY-MM-DDTHH:mm:ssZ', () => {
    expect(toExchangeObject(STORED)).toEqual({
      base_amount: '0.5',
      counter_amount: '125',
      node_index: 4,
      rate: '250.00000',
      tx_index: 12,
      buyer: 'rBuyer',
      executed_time: '2015-01-14T18:27:20Z',
      ledger_index: 11119603,
      offer_sequence: 59207,
      provider: 'rProvider',
      seller: 'rSeller',
      taker: 'rTaker',
      tx_hash: 'A'.repeat(64),
      tx_type: 'OfferCreate',
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XRP',
    });
  });

  it('the stored Float64 shadows and the client are not served, even when the row has them', () => {
    const wide = { ...STORED, base_amount_f: 0.5, counter_amount_f: 125, rate_f: 250, client: 'rt1.2.1' };
    const served = toExchangeObject(wide);
    for (const key of ['base_amount_f', 'counter_amount_f', 'rate_f', 'client', 'close_time']) {
      expect(served).not.toHaveProperty(key);
    }
  });

  describe('inverted', () => {
    it('swaps base and counter with their currencies, issuers and amounts, and buyer with seller', () => {
      const served = toExchangeObject(STORED, true);
      expect(served).toMatchObject({
        base_currency: 'XRP',
        counter_currency: 'USD',
        counter_issuer: ISSUER,
        base_amount: '125',
        counter_amount: '0.5',
        buyer: 'rSeller',
        seller: 'rBuyer',
      });
      expect(served).not.toHaveProperty('base_issuer');
      // what belongs to the trade, not to a side, stays
      expect(served).toMatchObject({
        taker: 'rTaker',
        provider: 'rProvider',
        offer_sequence: 59207,
        tx_hash: 'A'.repeat(64),
        ledger_index: 11119603,
        tx_index: 12,
        node_index: 4,
        executed_time: '2015-01-14T18:27:20Z',
      });
    });

    it('keeps the order of the keys: the issuer is now the counter one', () => {
      expect(Object.keys(toExchangeObject(STORED, true)).slice(-4)).toEqual([
        'tx_type',
        'base_currency',
        'counter_currency',
        'counter_issuer',
      ]);
    });

    it('the rate is 1 / rate to 8 significant digits', () => {
      expect(toExchangeObject(STORED, true).rate).toBe('0.0040000000');
      expect(toExchangeObject({ ...STORED, rate: '0.13661202185792351593' }, true).rate).toBe('7.3200000');
      expect(toExchangeObject({ ...STORED, rate: '3' }, true).rate).toBe('0.33333333');
      expect(toExchangeObject({ ...STORED, rate: '7' }, true).rate).toBe('0.14285714');
    });

    it('inverts a rate of the extremes of the ledger without losing it', () => {
      // an amount runs from 1e-81 to 1e96; 1 / 1e30 is 0 at the 20 decimal places BigNumber has by default
      expect(toExchangeObject({ ...STORED, rate: '1e30' }, true).rate).toBe('1.0000000e-30');
      expect(toExchangeObject({ ...STORED, rate: '1e-30' }, true).rate).toBe('1.0000000e+30');
      expect(toExchangeObject({ ...STORED, rate: '2.5e100' }, true).rate).toBe('4.0000000e-101');
      expect(toExchangeObject({ ...STORED, rate: '1e-150' }, true).rate).toBe('1.0000000e+150');
    });

    it('twice is the same exchange (up to the 8 digits of the rate)', () => {
      const once = toExchangeObject(STORED, true);
      const back = toExchangeObject(
        {
          ...STORED,
          base_currency: once.base_currency,
          base_issuer: once.base_issuer ?? '',
          counter_currency: once.counter_currency,
          counter_issuer: once.counter_issuer ?? '',
          base_amount: once.base_amount,
          counter_amount: once.counter_amount,
          buyer: once.buyer,
          seller: once.seller,
          rate: once.rate,
        },
        true,
      );
      expect(back).toEqual({ ...toExchangeObject(STORED), rate: '250.00000' });
    });
  });

  describe('the issuers', () => {
    it('are left out for the native currency, on either side', () => {
      const issued = { ...STORED, counter_currency: 'EUR', counter_issuer: 'rOther' };
      expect(toExchangeObject(issued)).toMatchObject({ base_issuer: ISSUER, counter_issuer: 'rOther' });
      const native = {
        ...STORED,
        base_currency: 'XRP',
        base_issuer: '',
        counter_currency: 'USD',
        counter_issuer: ISSUER,
      };
      const served = toExchangeObject(native);
      expect(served).not.toHaveProperty('base_issuer');
      expect(served.counter_issuer).toBe(ISSUER);
    });
  });

  describe('autobridged', () => {
    const bridged = { ...STORED, autobridged_currency: 'EUR', autobridged_issuer: 'rBridge' };

    it('puts the currency and the issuer in the f family, in front of buyer', () => {
      const served = toExchangeObject(bridged);
      expect(Object.keys(served).slice(5, 8)).toEqual(['autobridged_currency', 'autobridged_issuer', 'buyer']);
      expect(served).toMatchObject({ autobridged_currency: 'EUR', autobridged_issuer: 'rBridge' });
    });

    it('is the same from the other side', () => {
      expect(toExchangeObject(bridged, true)).toMatchObject({
        autobridged_currency: 'EUR',
        autobridged_issuer: 'rBridge',
      });
    });

    it('leaves out an issuer that is null or empty, and both for a plain exchange', () => {
      expect(toExchangeObject({ ...bridged, autobridged_issuer: null })).not.toHaveProperty('autobridged_issuer');
      expect(toExchangeObject({ ...bridged, autobridged_issuer: '' })).not.toHaveProperty('autobridged_issuer');
      const plain = toExchangeObject(STORED);
      expect(plain).not.toHaveProperty('autobridged_currency');
      expect(plain).not.toHaveProperty('autobridged_issuer');
    });
  });

  it('does not change its input', () => {
    // STORED is frozen: a write would throw in strict mode
    expect(() => toExchangeObject(STORED, true)).not.toThrow();
    expect(STORED.rate).toBe('250');
    expect(STORED.base_amount).toBe('0.5');
  });
});

const POOL = 'rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3';
/** A swap against an AMM pool as `exchanges` stores it: the pool is the provider and the account, there is no offer. */
const SWAP: StoredExchange = { ...STORED, amm_account: POOL, provider: POOL, offer_sequence: 0, tx_type: 'Payment' };

describe('toExchangeObject: a swap against an AMM pool', () => {
  const BOOK_KEYS = Object.keys(toExchangeObject(STORED));

  it('has amm_account as its last key, after the pair; an order-book exchange has no such key', () => {
    expect(Object.keys(toExchangeObject(SWAP))).toEqual([...BOOK_KEYS, 'amm_account']);
    expect(BOOK_KEYS).not.toContain('amm_account');
    expect(toExchangeObject(STORED)).not.toHaveProperty('amm_account');
    expect(toExchangeObject(SWAP).amm_account).toBe(POOL);
  });

  it('is last whichever keys the exchange has: both issuers, an autobridged currency, either orientation', () => {
    const full = {
      ...SWAP,
      counter_currency: 'EUR',
      counter_issuer: 'rOther',
      autobridged_currency: 'EUR',
      autobridged_issuer: 'rBridge',
    };
    for (const row of [full, SWAP]) {
      for (const inverted of [false, true]) {
        const keys = Object.keys(toExchangeObject(row, inverted));
        expect([inverted, keys.at(-1), keys.filter((k) => k === 'amm_account')]).toEqual([
          inverted,
          'amm_account',
          ['amm_account'],
        ]);
      }
    }
  });

  it('is the same pool from both sides, and changes nothing else of the exchange', () => {
    for (const inverted of [false, true]) {
      const { amm_account, ...rest } = toExchangeObject(SWAP, inverted) as unknown as Record<string, unknown>;
      expect(amm_account).toBe(POOL);
      expect(rest).toEqual({
        ...toExchangeObject({ ...STORED, provider: POOL, offer_sequence: 0, tx_type: 'Payment' }, inverted),
      });
    }
  });

  it('leaves the key out for an empty pool, as the order book stores it', () => {
    expect(Object.keys(toExchangeObject({ ...SWAP, amm_account: '' }))).toEqual(BOOK_KEYS);
  });
});

describe('toCsvRow', () => {
  it('has every column of the original in its order, an empty cell where the exchange has none', () => {
    const row = toCsvRow(toExchangeObject(STORED));
    expect(Object.keys(row)).toEqual([...EXCHANGE_CSV_COLUMNS]);
    expect(row).toMatchObject({
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_issuer: null,
      autobridged_currency: null,
      autobridged_issuer: null,
      node_index: 4,
      tx_hash: 'A'.repeat(64),
    });
  });

  it('adds amm_account as a last column for a swap against a pool, and no column for an order-book exchange', () => {
    expect(Object.keys(toCsvRow(toExchangeObject(STORED)))).toEqual([...EXCHANGE_CSV_COLUMNS]);
    const row = toCsvRow(toExchangeObject(SWAP));
    expect(Object.keys(row)).toEqual([...EXCHANGE_CSV_COLUMNS, 'amm_account']);
    expect((row as Record<string, unknown>).amm_account).toBe(POOL);
  });

  it('is the exchange and nothing else', () => {
    const exchange = toExchangeObject({
      ...STORED,
      counter_currency: 'EUR',
      counter_issuer: 'rOther',
      autobridged_currency: 'EUR',
      autobridged_issuer: 'rBridge',
    });
    const row = toCsvRow(exchange);
    expect(Object.keys(exchange).sort()).toEqual([...EXCHANGE_CSV_COLUMNS].sort());
    for (const [column, value] of Object.entries(row)) {
      expect([column, value]).toEqual([column, (exchange as unknown as Record<string, unknown>)[column]]);
    }
  });
});

describe('EXCHANGE_COLUMNS', () => {
  it('reads the close time as unix seconds and no Float64 shadow or client', () => {
    expect(EXCHANGE_COLUMNS).toContain('toUnixTimestamp(close_time) AS close_time');
    expect(EXCHANGE_COLUMNS).not.toMatch(/_f\b|client/);
    expect(EXCHANGE_COLUMNS.split(', ')).toHaveLength(21);
  });

  it('reads the pool of a swap against an AMM pool', () => {
    expect(EXCHANGE_COLUMNS.split(', ')).toContain('amm_account');
  });
});
