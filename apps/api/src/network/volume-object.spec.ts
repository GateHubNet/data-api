import BigNumber from 'bignumber.js';
import {
  AmmComponent,
  StoredVolumeRow,
  sumParts,
  toVolumeRow,
  TradeComponent,
  VolumeBucket,
  VolumePart,
} from './volume-object';

/** Freezes an object graph, so that a write to it throws (the objects are strict mode code). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const I1 = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const I2 = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const T0 = 1_421_193_600; // 2015-01-14T00:00:00Z
const bn = (v: string | number): BigNumber => new BigNumber(v);

const trade = (over: Partial<VolumePart> = {}): VolumePart => ({
  component: `USD.${I1}/XRP`,
  base: { currency: 'USD', issuer: I1 },
  counter: { currency: 'XRP' },
  amount: bn('30'),
  count: 3,
  converted: 90,
  ...over,
});

const payment = (over: Partial<VolumePart> = {}): VolumePart => ({
  component: 'XRP',
  base: { currency: 'XRP' },
  amount: bn('10.5'),
  count: 4,
  converted: 10.5,
  ...over,
});

const bucket = (parts: VolumePart[], extra: Partial<VolumeBucket> = {}): VolumeBucket => ({
  start: T0,
  parts,
  ...extra,
});

describe('toVolumeRow', () => {
  describe('the shape of the original (HBase columns in order, then what formatRows adds)', () => {
    it('a trade row has the keys components, count, exchange, total, exchange_rate, start_time', () => {
      const row = toVolumeRow('trade_volume', bucket([trade()]), 'XRP');
      expect(Object.keys(row)).toEqual(['components', 'count', 'exchange', 'total', 'exchange_rate', 'start_time']);
    });

    it('a row with an end (live or historical) adds end_time after start_time', () => {
      const row = toVolumeRow('trade_volume', bucket([trade()], { end: T0 + 86_400 }), 'XRP');
      expect(Object.keys(row)).toEqual([
        'components',
        'count',
        'exchange',
        'total',
        'exchange_rate',
        'start_time',
        'end_time',
      ]);
      expect(row.end_time).toBe('2015-01-15T00:00:00Z');
    });

    it('a trade component has count, rate, amount, base, counter, converted_amount', () => {
      const [component] = toVolumeRow('trade_volume', bucket([trade()]), 'XRP').components as TradeComponent[];
      expect(Object.keys(component)).toEqual(['count', 'rate', 'amount', 'base', 'counter', 'converted_amount']);
      expect(Object.keys(component.base as object)).toEqual(['currency', 'issuer']);
      expect(Object.keys(component.counter as object)).toEqual(['currency']);
    });

    it('a payment component has currency, issuer, amount, count, rate, converted_amount; the native one has no issuer key', () => {
      const row = toVolumeRow(
        'payment_volume',
        bucket([payment({ component: `USD.${I1}`, base: { currency: 'USD', issuer: I1 }, converted: 20 }), payment()]),
        'XRP',
      );
      expect(row.components.map((c) => Object.keys(c))).toEqual([
        ['currency', 'issuer', 'amount', 'count', 'rate', 'converted_amount'],
        ['currency', 'amount', 'count', 'rate', 'converted_amount'],
      ]);
    });

    it('the types of the original: count numbers; total, exchange_rate, rate, amount and converted_amount strings; times strings', () => {
      const row = toVolumeRow('trade_volume', bucket([trade()]), 'XRP');
      expect(typeof row.count).toBe('number');
      expect(typeof row.total).toBe('string');
      expect(typeof row.exchange_rate).toBe('string');
      expect(typeof row.start_time).toBe('string');
      const [c] = row.components;
      expect([typeof c.count, typeof c.rate, typeof c.amount, typeof c.converted_amount]).toEqual([
        'number',
        'string',
        'string',
        'string',
      ]);
      expect(row.exchange).toEqual({ currency: 'XRP' });
    });
  });

  describe('the values', () => {
    it('formats like the original: rate and exchange_rate to 8 significant digits, amounts and totals as JavaScript prints numbers', () => {
      const row = toVolumeRow(
        'trade_volume',
        bucket([trade({ amount: bn('128877.32679159139'), converted: 25919653.287050083, count: 12180 })]),
        'XRP',
      );
      expect(row.total).toBe('25919653.287050083');
      expect(row.exchange_rate).toBe('1.0000000');
      expect(row.components[0]).toMatchObject({
        amount: '128877.32679159139',
        converted_amount: '25919653.287050083',
        count: 12180,
      });
      // rate = amount / converted_amount: 0.0049721856 in 8 digits
      expect(row.components[0].rate).toBe('0.0049721856');
      expect(row.start_time).toBe('2015-01-14T00:00:00Z');
    });

    it('the rate of a component is the units of its currency a native coin buys: amount over converted amount', () => {
      const [c] = toVolumeRow('trade_volume', bucket([trade({ amount: bn('30'), converted: 90 })]), 'XRP').components;
      expect(c.rate).toBe('0.33333333');
    });

    it('sorts the components by converted amount, largest first, the same amount by component id; total and count add up', () => {
      const row = toVolumeRow(
        'trade_volume',
        bucket([
          trade({ component: 'B/XRP', converted: 30, count: 2 }),
          trade({ component: 'C/XRP', converted: 100, count: 5 }),
          trade({ component: 'A/XRP', converted: 30, count: 1 }),
        ]),
        'XRP',
      );
      expect(row.components.map((c) => c.converted_amount as string)).toEqual(['100', '30', '30']);
      expect(row.components.map((c) => c.count)).toEqual([5, 1, 2]);
      expect(row.total).toBe('160');
      expect(row.count).toBe(8);
    });

    it('a component with no converted amount (a currency without a rate) is not listed, though its payments are in the count', () => {
      const row = toVolumeRow(
        'payment_volume',
        bucket([
          payment(),
          payment({ component: `ZZZ.${I1}`, base: { currency: 'ZZZ', issuer: I1 }, count: 2, converted: 0 }),
        ]),
        'XRP',
      );
      expect(row.components).toHaveLength(1);
      expect(row.count).toBe(6);
      expect(row.total).toBe('10.5');
    });

    it('an empty bucket is a row with no component: count 0, total "0", the rate 1', () => {
      const row = toVolumeRow('trade_volume', bucket([]), 'XRP');
      expect(row).toEqual({
        components: [],
        count: 0,
        exchange: { currency: 'XRP' },
        total: '0',
        exchange_rate: '1.0000000',
        start_time: '2015-01-14T00:00:00Z',
      });
    });

    it('the native currency of the network is the exchange of the row: XAH on Xahau', () => {
      expect(toVolumeRow('trade_volume', bucket([]), 'XAH').exchange).toEqual({ currency: 'XAH' });
    });

    it('keeps the exact decimal text of an amount', () => {
      const row = toVolumeRow('payment_volume', bucket([payment({ amount: bn('0.1').plus('0.2') })]), 'XRP');
      expect(row.components[0].amount).toBe('0.3');
    });
  });

  describe('a display currency', () => {
    const display = (rate: string | number) => ({ asset: { currency: 'BTC', issuer: I2 }, rate: bn(rate) });

    it('converts like the original: total *= X, exchange_rate = X, rate /= X, converted_amount *= X; the exchange is the display currency', () => {
      const row = toVolumeRow(
        'trade_volume',
        bucket([trade({ amount: bn('30'), converted: 90 })]),
        'XRP',
        display('0.00002'),
      );
      expect(row.exchange).toEqual({ currency: 'BTC', issuer: I2 });
      expect(row.total).toBe(String(90 * 0.00002));
      expect(row.exchange_rate).toBe('0.000020000000');
      const [c] = row.components;
      expect(c.converted_amount).toBe(String(90 * 0.00002));
      // rate = amount / converted = 1/3; divided by X
      expect(Number(c.rate)).toBeCloseTo(30 / 90 / 0.00002, 1);
      expect(c.rate).toBe(new BigNumber(30 / 90 / 0.00002).toPrecision(8));
      expect(Object.keys(row)).toEqual(['components', 'count', 'exchange', 'total', 'exchange_rate', 'start_time']);
    });

    it('converted_amount = amount / rate holds after the conversion', () => {
      const row = toVolumeRow(
        'payment_volume',
        bucket([
          payment({ amount: bn('10'), converted: 20, component: `USD.${I1}`, base: { currency: 'USD', issuer: I1 } }),
        ]),
        'XRP',
        display('0.5'),
      );
      const [c] = row.components;
      expect(Number(c.converted_amount)).toBeCloseTo(Number(c.amount) / Number(c.rate), 6);
    });

    it('with no rate (X is 0) the row is zeros, as the original: total "0", exchange_rate 0.0000000, rate "0", converted "0"', () => {
      const row = toVolumeRow('trade_volume', bucket([trade()]), 'XRP', display(0));
      expect(row.total).toBe('0');
      expect(row.exchange_rate).toBe('0.0000000');
      expect(row.components).toHaveLength(1);
      expect(row.components[0].rate).toBe('0');
      // always a string (the original left the number 0 there)
      expect(row.components[0].converted_amount).toBe('0');
      expect(row.count).toBe(3);
    });

    it('a display currency that is the native one is no conversion', () => {
      const row = toVolumeRow('trade_volume', bucket([trade()]), 'XRP', { asset: { currency: 'XRP' }, rate: bn(1) });
      expect(row.exchange).toEqual({ currency: 'XRP' });
      expect(row.exchange_rate).toBe('1.0000000');
      expect(row.total).toBe('90');
    });
  });

  it('does not change what it is given', () => {
    const input = deepFreeze(bucket([trade(), trade({ component: 'X/XRP', converted: 5 })], { end: T0 + 3600 }));
    expect(() =>
      toVolumeRow('trade_volume', input, 'XRP', { asset: { currency: 'BTC', issuer: I2 }, rate: bn('0.5') }),
    ).not.toThrow();
  });
});

describe('sumParts', () => {
  const stored = (over: Partial<StoredVolumeRow> = {}): StoredVolumeRow => ({
    component: `USD.${I1}/XRP`,
    base_currency: 'USD',
    base_issuer: I1,
    counter_currency: 'XRP',
    counter_issuer: '',
    amount: '30',
    count: 3,
    converted_f: 90,
    ...over,
  });

  it('is one part per row for one day, the sentinel (component empty) skipped', () => {
    const parts = sumParts([
      stored({
        component: '',
        base_currency: '',
        base_issuer: '',
        counter_currency: '',
        amount: '0',
        count: 0,
        converted_f: 0,
      }),
      stored(),
    ]);
    expect(parts).toEqual([
      {
        component: `USD.${I1}/XRP`,
        base: { currency: 'USD', issuer: I1 },
        counter: { currency: 'XRP' },
        amount: bn('30'),
        count: 3,
        converted: 90,
      },
    ]);
  });

  it('adds the days of a component: the amounts exactly, the counts, the converted amounts', () => {
    const parts = sumParts([
      stored({ amount: '0.1', count: 1, converted_f: 1.5 }),
      stored({ amount: '0.2', count: 2, converted_f: 2.5 }),
      stored({ component: `EUR.${I1}/XRP`, base_currency: 'EUR', amount: '5', count: 7, converted_f: 40 }),
    ]);
    expect(parts).toHaveLength(2);
    const usd = parts.find((p) => p.component.startsWith('USD')) as VolumePart;
    expect(usd.amount.toFixed()).toBe('0.3');
    expect([usd.count, usd.converted]).toEqual([3, 4]);
  });

  it('keeps a component apart when its sides were swapped on another day: the amounts are in different currencies', () => {
    const parts = sumParts([
      stored({
        component: `FOO.${I1}/USD.${I1}`,
        base_currency: 'FOO',
        base_issuer: I1,
        counter_currency: 'USD',
        counter_issuer: I1,
        amount: '100',
        converted_f: 10,
      }),
      stored({
        component: `FOO.${I1}/USD.${I1}`,
        base_currency: 'USD',
        base_issuer: I1,
        counter_currency: 'FOO',
        counter_issuer: I1,
        amount: '30',
        converted_f: 12,
      }),
    ]);
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.base.currency).sort()).toEqual(['FOO', 'USD']);
  });

  it('a payment row is a currency alone: the counter columns are empty', () => {
    const [part] = sumParts([
      stored({
        component: 'XRP',
        base_currency: 'XRP',
        base_issuer: '',
        counter_currency: '',
        counter_issuer: '',
        amount: '10.5',
        count: 4,
        converted_f: 10.5,
      }),
    ]);
    expect(part.base).toEqual({ currency: 'XRP' });
    expect(part.counter).toBeUndefined();
    expect(Object.keys(part.base)).toEqual(['currency']);
  });

  it('rows without a converted amount are not added to the component: 9 unrated units and 4 at rate 2 are 4 units at rate 2, and the payments of both are in the count', () => {
    const unrated = stored({
      component: `USD.${I1}`,
      base_currency: 'USD',
      base_issuer: I1,
      counter_currency: '',
      counter_issuer: '',
      amount: '9',
      count: 3,
      converted_f: 0,
    });
    const rated = { ...unrated, amount: '4', count: 2, converted_f: 2 };
    for (const rows of [
      [unrated, rated],
      [rated, unrated],
    ]) {
      const parts = sumParts(rows);
      expect(parts).toHaveLength(2);
      const row = toVolumeRow('payment_volume', bucket(parts), 'XRP');
      expect(row.components).toEqual([
        { currency: 'USD', issuer: I1, amount: '4', count: 2, rate: '2.0000000', converted_amount: '2' },
      ]);
      expect(row.count).toBe(5);
      expect(row.total).toBe('2');
    }
  });

  it('several unrated days stay one part that is never listed; their payments add up in the count', () => {
    const unrated = (count: number) =>
      stored({
        component: `ZZZ.${I1}`,
        base_currency: 'ZZZ',
        base_issuer: I1,
        counter_currency: '',
        counter_issuer: '',
        amount: '5',
        count,
        converted_f: 0,
      });
    const parts = sumParts([unrated(2), unrated(4)]);
    expect(parts).toHaveLength(1);
    const row = toVolumeRow('payment_volume', bucket(parts), 'XRP');
    expect(row.components).toEqual([]);
    expect(row.count).toBe(6);
  });

  it('a row of zero converted amount (a currency without a rate) stays a part, to be counted', () => {
    const parts = sumParts([stored({ converted_f: 0, count: 2 })]);
    expect(parts[0].converted).toBe(0);
    expect(parts[0].count).toBe(2);
  });

  it('takes the numbers as text too (a 64-bit column comes back as text on some settings)', () => {
    const [part] = sumParts([stored({ count: '12' as unknown as number, converted_f: '4.5' as unknown as number })]);
    expect([part.count, part.converted]).toEqual([12, 4.5]);
  });

  it('does not change what it is given', () => {
    expect(() => sumParts(deepFreeze([stored(), stored({ amount: '1' })]))).not.toThrow();
  });
});

describe('the AMM volume row', () => {
  const POOL = 'rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3';
  const POOL2 = 'rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd';
  const amm = (over: Partial<VolumePart> = {}): VolumePart => ({
    component: POOL,
    base: { currency: 'USD', issuer: I1 },
    counter: { currency: 'XRP' },
    amount: bn('30'),
    count: 3,
    converted: 90,
    ...over,
  });

  it('is a row with the keys of every volume row', () => {
    const row = toVolumeRow('amm_volume', bucket([amm()], { end: T0 + 86_400 }), 'XRP');
    expect(Object.keys(row)).toEqual([
      'components',
      'count',
      'exchange',
      'total',
      'exchange_rate',
      'start_time',
      'end_time',
    ]);
  });

  it('a component is amm_account, base, counter, count, amount, rate, converted_amount, in this order', () => {
    const [component] = toVolumeRow('amm_volume', bucket([amm()]), 'XRP').components as AmmComponent[];
    expect(Object.keys(component)).toEqual([
      'amm_account',
      'base',
      'counter',
      'count',
      'amount',
      'rate',
      'converted_amount',
    ]);
    expect(component).toEqual({
      amm_account: POOL,
      base: { currency: 'USD', issuer: I1 },
      counter: { currency: 'XRP' },
      count: 3,
      amount: '30',
      rate: '0.33333333',
      converted_amount: '90',
    });
    // the sides are formatted as the trade components format them: an issuer key only for an issued currency
    expect(Object.keys(component.base)).toEqual(['currency', 'issuer']);
    expect(Object.keys(component.counter)).toEqual(['currency']);
    expect([
      typeof component.count,
      typeof component.amount,
      typeof component.rate,
      typeof component.converted_amount,
    ]).toEqual(['number', 'string', 'string', 'string']);
  });

  it('is sorted by converted amount, largest first, the same amount by pool account; total and count add up', () => {
    const row = toVolumeRow(
      'amm_volume',
      bucket([
        amm({ component: POOL2, converted: 30, count: 2 }),
        amm({ component: 'rZ', converted: 100, count: 5 }),
        amm({ component: POOL, converted: 30, count: 1 }),
      ]),
      'XRP',
    );
    expect((row.components as AmmComponent[]).map((c) => c.amm_account)).toEqual(['rZ', POOL2, POOL]);
    expect(row.total).toBe('160');
    expect(row.count).toBe(8);
  });

  it('a pool without a converted amount is not listed, as a trade component without one is not', () => {
    const row = toVolumeRow('amm_volume', bucket([amm({ converted: 0 })]), 'XRP');
    expect(row.components).toEqual([]);
    expect(row.count).toBe(3);
    expect(row.total).toBe('0');
  });

  it('a display currency converts as it does a trade row: total, exchange_rate, rate / X, converted_amount * X', () => {
    const row = toVolumeRow('amm_volume', bucket([amm()]), 'XRP', {
      asset: { currency: 'BTC', issuer: I2 },
      rate: bn('0.5'),
    });
    expect(row.exchange).toEqual({ currency: 'BTC', issuer: I2 });
    expect(row.exchange_rate).toBe('0.50000000');
    expect(row.total).toBe('45');
    const [c] = row.components as AmmComponent[];
    expect(Object.keys(c)).toEqual(['amm_account', 'base', 'counter', 'count', 'amount', 'rate', 'converted_amount']);
    expect(c.converted_amount).toBe('45');
    expect(c.rate).toBe('0.66666667');
    expect(c.amount).toBe('30');
  });

  describe('fees_est (the estimated fees of the live day row, D2b.3, D9)', () => {
    it('a component with an estimate has fees_est after converted_amount, the row has it after end_time', () => {
      const row = toVolumeRow('amm_volume', bucket([amm({ feesEst: 0.75 })], { end: T0 + 86_400 }), 'XRP');
      expect(Object.keys(row)).toEqual([
        'components',
        'count',
        'exchange',
        'total',
        'exchange_rate',
        'start_time',
        'end_time',
        'fees_est',
      ]);
      const [c] = row.components as AmmComponent[];
      expect(Object.keys(c)).toEqual([
        'amm_account',
        'base',
        'counter',
        'count',
        'amount',
        'rate',
        'converted_amount',
        'fees_est',
      ]);
      expect([c.fees_est, row.fees_est]).toEqual(['0.75', '0.75']);
      expect([typeof c.fees_est, typeof row.fees_est]).toEqual(['string', 'string']);
    });

    it('an estimate of 0 is an estimate: the text "0", not a missing key', () => {
      const row = toVolumeRow('amm_volume', bucket([amm({ feesEst: 0 })]), 'XRP');
      expect([(row.components[0] as AmmComponent).fees_est, row.fees_est]).toEqual(['0', '0']);
    });

    it('a row without an end has fees_est right after start_time', () => {
      const row = toVolumeRow('amm_volume', bucket([amm({ feesEst: 1 })]), 'XRP');
      expect(Object.keys(row).slice(-2)).toEqual(['start_time', 'fees_est']);
    });

    it('the row sums the components, which keep the order of the converted amounts', () => {
      const row = toVolumeRow(
        'amm_volume',
        bucket([
          amm({ component: POOL, converted: 90, feesEst: 0.25 }),
          amm({ component: POOL2, converted: 100, feesEst: 0.5 }),
          amm({ component: 'rZ', converted: 10, feesEst: 0.125 }),
        ]),
        'XRP',
      );
      expect((row.components as AmmComponent[]).map((c) => [c.amm_account, c.fees_est])).toEqual([
        [POOL2, '0.5'],
        [POOL, '0.25'],
        ['rZ', '0.125'],
      ]);
      expect(row.fees_est).toBe('0.875');
    });

    it('a display currency converts them like converted_amount: fees_est * X per component, (the sum) * X for the row', () => {
      const row = toVolumeRow(
        'amm_volume',
        bucket([amm({ component: POOL, feesEst: 1 }), amm({ component: POOL2, converted: 30, feesEst: 0.5 })]),
        'XRP',
        { asset: { currency: 'BTC', issuer: I2 }, rate: bn('0.5') },
      );
      expect((row.components as AmmComponent[]).map((c) => [c.converted_amount, c.fees_est])).toEqual([
        ['45', '0.5'],
        ['15', '0.25'],
      ]);
      expect(row.total).toBe('60');
      expect(row.fees_est).toBe('0.75');
    });

    it('a display currency whose rate is 0 makes the estimates 0 as it makes the amounts 0', () => {
      const row = toVolumeRow('amm_volume', bucket([amm({ feesEst: 1 })]), 'XRP', {
        asset: { currency: 'BTC', issuer: I2 },
        rate: bn(0),
      });
      expect([(row.components[0] as AmmComponent).fees_est, row.fees_est]).toEqual(['0', '0']);
    });

    it('a component whose estimate is not known has no fees_est, and then the row has none', () => {
      const row = toVolumeRow(
        'amm_volume',
        bucket([
          amm({ component: POOL, converted: 90, feesEst: 0.25 }),
          amm({ component: POOL2, converted: 30, feesEst: null }),
        ]),
        'XRP',
      );
      const [known, unknown] = row.components as AmmComponent[];
      expect(Object.keys(known)).toContain('fees_est');
      expect(Object.keys(unknown)).toEqual([
        'amm_account',
        'base',
        'counter',
        'count',
        'amount',
        'rate',
        'converted_amount',
      ]);
      expect(Object.keys(row)).not.toContain('fees_est');
    });

    it('a part without feesEst (the key absent) has no fees_est either, and the row neither', () => {
      const row = toVolumeRow('amm_volume', bucket([amm()]), 'XRP');
      expect(Object.keys(row.components[0])).not.toContain('fees_est');
      expect(Object.keys(row)).not.toContain('fees_est');
      const mixed = toVolumeRow(
        'amm_volume',
        bucket([amm({ feesEst: 1 }), amm({ component: POOL2, converted: 5 })]),
        'XRP',
      );
      expect(Object.keys(mixed.components[0])).toContain('fees_est');
      expect(Object.keys(mixed.components[1])).not.toContain('fees_est');
      expect(Object.keys(mixed)).not.toContain('fees_est');
    });

    it('a part that is not listed (no converted amount) does not count: the others make the row', () => {
      const row = toVolumeRow(
        'amm_volume',
        bucket([amm({ feesEst: 0.5 }), amm({ component: POOL2, converted: 0, feesEst: null })]),
        'XRP',
      );
      expect(row.components).toHaveLength(1);
      expect(row.fees_est).toBe('0.5');
    });

    it('a row that lists no component has no fees_est', () => {
      expect(Object.keys(toVolumeRow('amm_volume', bucket([]), 'XRP'))).not.toContain('fees_est');
      const unlisted = toVolumeRow('amm_volume', bucket([amm({ converted: 0, feesEst: 1 })]), 'XRP');
      expect(unlisted.components).toEqual([]);
      expect(Object.keys(unlisted)).not.toContain('fees_est');
    });

    it('trade and payment rows have none, whatever the parts carry', () => {
      const trades = toVolumeRow('trade_volume', bucket([trade({ feesEst: 1 })], { end: T0 + 86_400 }), 'XRP');
      expect(Object.keys(trades)).not.toContain('fees_est');
      expect(Object.keys(trades.components[0])).not.toContain('fees_est');
      const payments = toVolumeRow('payment_volume', bucket([payment({ feesEst: 1 })]), 'XRP');
      expect(Object.keys(payments)).not.toContain('fees_est');
      expect(Object.keys(payments.components[0])).not.toContain('fees_est');
    });

    const storedPool = (over: Partial<StoredVolumeRow> = {}): StoredVolumeRow => ({
      component: POOL,
      base_currency: 'USD',
      base_issuer: I1,
      counter_currency: 'XRP',
      counter_issuer: '',
      amount: '10',
      count: 2,
      converted_f: 30,
      ...over,
    });

    it('sumParts takes the estimate of a stored row, and leaves the part without one when the row has no such column', () => {
      expect(sumParts([storedPool({ fees_est_f: 0.25 })])[0].feesEst).toBe(0.25);
      // a Float64 may come back as text
      expect(sumParts([storedPool({ fees_est_f: '0.5' })])[0].feesEst).toBe(0.5);
      // NULL: the estimate is not known
      expect(sumParts([storedPool({ fees_est_f: null })])[0].feesEst).toBeNull();
      // the column was not read (the daily sets): the key is not there at all
      expect(Object.keys(sumParts([storedPool()])[0])).not.toContain('feesEst');
    });

    it('sumParts adds the estimates of the rows of a part, and one that is not known makes the sum not known', () => {
      const fees = (a: number | null, b: number | null): number | null =>
        sumParts([storedPool({ fees_est_f: a }), storedPool({ fees_est_f: b })])[0].feesEst as number | null;
      expect(fees(0.25, 0.5)).toBe(0.75);
      expect(fees(0.25, null)).toBeNull();
      expect(fees(null, 0.25)).toBeNull();
      expect(fees(null, null)).toBeNull();
    });
  });

  it('sums the days of a bucket per pool and sides: the pool of another orientation on another day is a part of its own', () => {
    const stored = (over: Partial<StoredVolumeRow> = {}): StoredVolumeRow => ({
      component: POOL,
      base_currency: 'USD',
      base_issuer: I1,
      counter_currency: 'XRP',
      counter_issuer: '',
      amount: '10',
      count: 2,
      converted_f: 30,
      ...over,
    });
    const parts = sumParts([
      stored(),
      stored({ amount: '5', count: '1', converted_f: 15 }),
      stored({ base_currency: 'XRP', base_issuer: '', counter_currency: 'USD', counter_issuer: I1 }),
      stored({ component: '' }),
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ component: POOL, count: 3, converted: 45 });
    expect(parts[0].amount.toString()).toBe('15');
  });
});
