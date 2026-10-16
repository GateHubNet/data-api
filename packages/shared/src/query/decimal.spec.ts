import BigNumber from 'bignumber.js';
import {
  EXACT_LIMIT,
  EXACT_SCALE,
  exactAmount,
  ratio,
  VOLUME_SOURCE_COLUMNS,
  volumeColumns,
  volumesOf,
} from './decimal';

describe('ratio', () => {
  it('keeps eight digits where the default 20 places would lose them', () => {
    // the inverse of a rate above 1e12 is 0 at 20 places
    expect(new BigNumber(1).dividedBy('2.5e+30').toFixed()).toBe('0');
    expect(ratio(1, '2.5e+30').toPrecision(8)).toBe('4.0000000e-31');
    expect(ratio('1e-150', '4e+30').toPrecision(8)).toBe('2.5000000e-181');
  });

  it("is an ordinary BigNumber that kept all its places, so the caller's own arithmetic is not widened", () => {
    const third = ratio(1, 3);
    expect(third).toBeInstanceOf(BigNumber);
    expect(third.decimalPlaces()).toBe(200);
    expect(third.times(3).toFixed().startsWith('0.9999999')).toBe(true);
    // the caller's division still has the default 20 places
    expect(third.dividedBy(7).decimalPlaces()).toBe(20);
  });

  it('is exact where the quotient is', () => {
    expect(ratio(10, 4).toFixed()).toBe('2.5');
    expect(ratio(0, 4).toFixed()).toBe('0');
  });
});

describe('exactAmount', () => {
  it('reads the exact decimal of the column only when the decimal holds it whole', () => {
    const sql = exactAmount('base_amount');
    expect(sql).toContain(`toDecimal256OrNull(base_amount, ${EXACT_SCALE})`);
    expect(sql).toContain(`base_amount_f < ${EXACT_LIMIT}`);
    expect(sql).toContain(`<= ${EXACT_SCALE}`);
    expect(exactAmount('counter_amount')).toContain('counter_amount_f < ');
    expect(exactAmount('counter_amount')).not.toContain('base_amount');
  });
});

describe('volumeColumns', () => {
  it('sums every row of the source', () => {
    const sql = volumeColumns();
    expect(sql).toContain('toUInt32(count()) AS n');
    expect(sql).toContain('toString(sum(base_exact)) AS base_sum');
    expect(sql).toContain('toString(sum(counter_exact)) AS counter_sum');
    expect(sql).toContain('countIf(base_exact IS NULL OR counter_exact IS NULL)');
    expect(sql).toContain('sumKahan(base_amount_f) AS base_sum_f');
    expect(sql).not.toContain('sumIf');
  });

  it('with a condition, sums only the rows that meet it, and counts only their misfits', () => {
    const sql = volumeColumns('counter_amount_f > 0.0005');
    expect(sql).toContain('toUInt32(countIf(counter_amount_f > 0.0005)) AS n');
    expect(sql).toContain('toString(sumIf(base_exact, counter_amount_f > 0.0005)) AS base_sum');
    expect(sql).toContain('sumKahanIf(counter_amount_f, counter_amount_f > 0.0005) AS counter_sum_f');
    expect(sql).toContain('countIf((counter_amount_f > 0.0005) AND (base_exact IS NULL OR counter_exact IS NULL))');
  });

  it('reads the columns of the source it is given', () => {
    expect(VOLUME_SOURCE_COLUMNS).toContain('AS base_exact');
    expect(VOLUME_SOURCE_COLUMNS).toContain('AS counter_exact');
    expect(VOLUME_SOURCE_COLUMNS).toContain('base_amount_f');
    expect(VOLUME_SOURCE_COLUMNS).toContain('counter_amount_f');
  });
});

describe('volumesOf', () => {
  const row = { n: 2, base_sum: '10.5', counter_sum: '0.25', unfit: 0, base_sum_f: 10.5, counter_sum_f: 0.25 };

  it('the exact sums', () => {
    const v = volumesOf(row);
    expect([v.base.toFixed(), v.counter.toFixed()]).toEqual(['10.5', '0.25']);
  });

  it('the exact sums as ClickHouse writes a decimal, with its trailing zeros', () => {
    const v = volumesOf({
      ...row,
      base_sum: '10.500000000000000000000000000000',
      counter_sum: '0.250000000000000000000000000000',
    });
    expect([v.base.toString(), v.counter.toString()]).toEqual(['10.5', '0.25']);
  });

  it('the float sums when an amount did not fit a decimal, never the exact ones that left it out', () => {
    const v = volumesOf({ ...row, unfit: 1, base_sum: '0', counter_sum: '5', base_sum_f: 1.5e-35, counter_sum_f: 5 });
    expect([v.base.toString(), v.counter.toString()]).toEqual(['1.5e-35', '5']);
  });

  it('nothing to sum is 0', () => {
    const none = volumesOf({
      n: 0,
      base_sum: null,
      counter_sum: null,
      unfit: 0,
      base_sum_f: null,
      counter_sum_f: null,
    });
    expect([none.base.toFixed(), none.counter.toFixed()]).toEqual(['0', '0']);
    const noneF = volumesOf({
      n: 0,
      base_sum: null,
      counter_sum: null,
      unfit: 1,
      base_sum_f: null,
      counter_sum_f: null,
    });
    expect([noneF.base.toFixed(), noneF.counter.toFixed()]).toEqual(['0', '0']);
  });
});
