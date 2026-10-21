import {
  AccountGroup,
  attachExchanges,
  BUYER,
  SELLER,
  StoredActiveExchange,
  toActiveAccounts,
  toActiveExchange,
} from './active-account-object';

/** A group as the query reads it: `n` exchanges of `account` in one role, with the sums of their amounts. */
function group(
  account: string,
  role: typeof BUYER | typeof SELLER,
  at: [number, number, number],
  n: number,
  base: string,
  counter: string,
  over: Partial<AccountGroup> = {},
): AccountGroup {
  return {
    account,
    role,
    first_pos: at,
    n,
    base_sum: base,
    counter_sum: counter,
    unfit: 0,
    base_sum_f: Number(base),
    counter_sum_f: Number(counter),
    ...over,
  };
}

describe('toActiveAccounts', () => {
  // one exchange, 10 USD for 20 XRP, in the stored orientation: rB bought, rS sold
  const trade = [group('rB', BUYER, [5, 1, 1], 1, '10', '20'), group('rS', SELLER, [5, 1, 1], 1, '10', '20')];

  it('the buyer of the stored pair buys, the seller sells; the accounts are in the keys of the original', () => {
    const { accounts, exchanges } = toActiveAccounts(trade, false);
    expect(exchanges).toBe(1);
    // equal volumes: the seller of the exchange is met first
    expect(JSON.stringify(accounts)).toBe(
      JSON.stringify([
        {
          buy: { base_volume: '0', counter_volume: '0', count: 0 },
          sell: { base_volume: '10', counter_volume: '20', count: 1 },
          account: 'rS',
          base_volume: '10',
          counter_volume: '20',
          count: 1,
        },
        {
          buy: { base_volume: '10', counter_volume: '20', count: 1 },
          sell: { base_volume: '0', counter_volume: '0', count: 0 },
          account: 'rB',
          base_volume: '10',
          counter_volume: '20',
          count: 1,
        },
      ]),
    );
  });

  it('asked the other way round the sides swap, and so do the volumes (base is what was counter)', () => {
    const { accounts } = toActiveAccounts(trade, true);
    // the buyer of the stored pair is the seller of the inverted one, and is met first
    expect(accounts.map((a) => [a.account, a.buy.count, a.sell.count])).toEqual([
      ['rB', 0, 1],
      ['rS', 1, 0],
    ]);
    expect(accounts[1]).toMatchObject({ account: 'rS', base_volume: '20', counter_volume: '10' });
    expect(accounts[1].buy).toEqual({ base_volume: '20', counter_volume: '10', count: 1 });
  });

  it('sorts by base volume, descending, and an equal volume keeps the order of the first exchange', () => {
    const groups = [
      group('rA', SELLER, [5, 1, 1], 1, '10', '1'),
      group('rA', BUYER, [9, 1, 1], 1, '5', '1'), // 15 in all
      group('rB', BUYER, [5, 1, 1], 1, '10', '1'),
      group('rC', SELLER, [5, 2, 1], 1, '10', '1'),
      group('rD', BUYER, [4, 9, 9], 1, '10', '1'),
      group('rE', SELLER, [4, 9, 9], 1, '10', '1'),
    ];
    // the seller is met before the buyer of the same exchange, an earlier ledger before a later one
    expect(toActiveAccounts(groups, false).accounts.map((a) => a.account)).toEqual(['rA', 'rE', 'rD', 'rB', 'rC']);
    // asked the other way round the seller of the original is the buyer of the stored exchange
    expect(toActiveAccounts(groups, true).accounts.map((a) => a.account)).toEqual(['rA', 'rD', 'rE', 'rB', 'rC']);
  });

  it('adds the sides exactly: 0.1 + 0.2 is 0.3', () => {
    const { accounts } = toActiveAccounts(
      [group('rA', BUYER, [1, 1, 1], 1, '0.1', '0.1'), group('rA', SELLER, [2, 1, 1], 1, '0.2', '0.2')],
      false,
    );
    expect(accounts[0]).toMatchObject({ base_volume: '0.3', counter_volume: '0.3', count: 2 });
  });

  it('a side with an amount the exact sums cannot hold is the float sum; the account is, if either side is', () => {
    const { accounts } = toActiveAccounts(
      [
        group('rA', BUYER, [1, 1, 1], 1, '0', '2', { unfit: 1, base_sum: null, base_sum_f: 1e-35 }),
        group('rA', SELLER, [2, 1, 1], 1, '0.5', '1', { base_sum_f: 0.5 }),
      ],
      false,
    );
    expect(accounts[0]).toEqual({
      buy: { base_volume: '1e-35', counter_volume: '2', count: 1 },
      sell: { base_volume: '0.5', counter_volume: '1', count: 1 },
      account: 'rA',
      base_volume: '0.5',
      counter_volume: '3',
      count: 2,
    });
  });

  it('no groups, no accounts', () => {
    expect(toActiveAccounts([], false)).toEqual({ accounts: [], exchanges: 0 });
  });
});

describe('toActiveExchange and attachExchanges', () => {
  const row = (over: Partial<StoredActiveExchange> = {}): StoredActiveExchange => ({
    base_currency: 'USD',
    base_issuer: 'rIssuer',
    counter_currency: 'XRP',
    counter_issuer: '',
    ledger_index: 7,
    tx_index: 2,
    node_index: 3,
    tx_hash: 'AB',
    close_time: 1421260040,
    base_amount: '10',
    counter_amount: '20',
    rate: '2',
    buyer: 'rB',
    seller: 'rS',
    taker: 'rS',
    provider: 'rB',
    offer_sequence: 4,
    amm_account: '',
    autobridged_currency: null,
    autobridged_issuer: null,
    tx_type: 'OfferCreate',
    client: null,
    ...over,
  });

  it('is the exchange of the API without the pair, and with the time to the millisecond', () => {
    const e = toActiveExchange(row(), false);
    expect(Object.keys(e)).toEqual([
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
    ]);
    expect(e).toMatchObject({ executed_time: '2015-01-14T18:27:20.000Z', rate: '2.0000000', base_amount: '10' });
  });

  it('a swap against an AMM pool has amm_account as its last key; an order-book exchange has no such key', () => {
    const book = Object.keys(toActiveExchange(row(), false));
    expect(book).not.toContain('amm_account');
    for (const inverted of [false, true]) {
      const e = toActiveExchange(
        row({ amm_account: 'rPool', provider: 'rPool', offer_sequence: 0, client: 'rt1.2.1' }),
        inverted,
      );
      expect(Object.keys(e).at(-1)).toBe('amm_account');
      expect(e.amm_account).toBe('rPool');
    }
    expect(Object.keys(toActiveExchange(row({ amm_account: 'rPool' }), false))).toEqual([...book, 'amm_account']);
  });

  it('keeps the client of the transaction, between the buyer and the time, as the row of HBase had it', () => {
    for (const inverted of [false, true]) {
      const e = toActiveExchange(
        row({ client: 'rt1.2.1', autobridged_currency: 'EUR', autobridged_issuer: 'rEur' }),
        inverted,
      );
      expect(Object.keys(e)).toEqual([
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'autobridged_currency',
        'autobridged_issuer',
        'buyer',
        'client',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
      ]);
      // the client is of the transaction: the same from both sides
      expect(e.client).toBe('rt1.2.1');
    }
    // an exchange without a client has no key
    expect(toActiveExchange(row(), false)).not.toHaveProperty('client');
  });

  it('asked the other way round: the amounts, the parties and the rate are inverted', () => {
    expect(toActiveExchange(row(), true)).toMatchObject({
      base_amount: '20',
      counter_amount: '10',
      buyer: 'rS',
      seller: 'rB',
      rate: '0.50000000',
    });
  });

  it('an autobridged exchange keeps its autobridged currency and issuer', () => {
    const e = toActiveExchange(row({ autobridged_currency: 'EUR', autobridged_issuer: 'rEur' }), false);
    expect(e).toMatchObject({ autobridged_currency: 'EUR', autobridged_issuer: 'rEur' });
  });

  it('attaches each exchange to its seller and then its buyer, in the order given; a self trade is there twice', () => {
    const { accounts } = toActiveAccounts(
      [
        group('rB', BUYER, [7, 2, 3], 1, '10', '20'),
        group('rS', SELLER, [7, 2, 3], 1, '10', '20'),
        group('rX', BUYER, [8, 1, 1], 1, '1', '1'),
        group('rX', SELLER, [8, 1, 1], 1, '1', '1'),
      ],
      false,
    );
    const rows = [
      row(),
      row({ ledger_index: 8, tx_index: 1, node_index: 1, tx_hash: 'CD', buyer: 'rX', seller: 'rX' }),
    ];
    attachExchanges(accounts, rows, false);
    const byName = new Map(accounts.map((a) => [a.account, a]));
    expect(byName.get('rB')?.exchanges?.map((e) => e.tx_hash)).toEqual(['AB']);
    expect(byName.get('rS')?.exchanges?.map((e) => e.tx_hash)).toEqual(['AB']);
    expect(byName.get('rX')?.exchanges?.map((e) => e.tx_hash)).toEqual(['CD', 'CD']);
    // `exchanges` is the last key of an account
    expect(Object.keys(accounts[0]).pop()).toBe('exchanges');
    // the same object in the two lists
    expect(byName.get('rB')?.exchanges?.[0]).toBe(byName.get('rS')?.exchanges?.[0]);
  });

  it('inverted, the seller of the original is the buyer of the stored exchange', () => {
    const { accounts } = toActiveAccounts(
      [group('rB', BUYER, [7, 2, 3], 1, '10', '20'), group('rS', SELLER, [7, 2, 3], 1, '10', '20')],
      true,
    );
    attachExchanges(accounts, [row()], true);
    expect(accounts.map((a) => [a.account, a.exchanges?.length])).toEqual([
      ['rB', 1],
      ['rS', 1],
    ]);
    expect(accounts[0].exchanges?.[0]).toMatchObject({ seller: 'rB', buyer: 'rS' });
  });

  it('an exchange of an account that is not in the list is left out', () => {
    const { accounts } = toActiveAccounts([group('rB', BUYER, [7, 2, 3], 1, '10', '20')], false);
    expect(() => attachExchanges(accounts, [row()], false)).not.toThrow();
    expect(accounts[0].exchanges?.length).toBe(1);
  });
});
