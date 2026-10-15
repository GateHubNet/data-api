import BigNumber from 'bignumber.js';
import { dropsToXrp } from 'xrpl';
import { dropsToNative } from './amount';

describe('dropsToNative', () => {
  it.each([
    ['0', '0'],
    ['1', '0.000001'],
    ['12', '0.000012'],
    ['1000000', '1'],
    ['100000000', '100'],
    ['123456789', '123.456789'],
    ['99999999999999999', '99999999999.999999'],
    ['-1', '-0.000001'],
    ['-100000000', '-100'],
  ])('converts %s drops to %s', (drops, native) => {
    expect(dropsToNative(drops)).toBe(native);
  });

  it('accepts a string, a number or a BigNumber', () => {
    expect(dropsToNative('2500000')).toBe('2.5');
    expect(dropsToNative(2500000)).toBe('2.5');
    expect(dropsToNative(new BigNumber('2500000'))).toBe('2.5');
  });

  it('never uses exponent notation', () => {
    expect(dropsToNative('1')).toBe('0.000001');
    expect(dropsToNative(new BigNumber('1e17'))).toBe('100000000000');
    expect(dropsToNative('100000000000000000000000')).toBe('100000000000000000');
  });

  it('is exact for values beyond 2^53', () => {
    expect(dropsToNative('9007199254740993')).toBe('9007199254.740993');
  });

  it.each(['1.5', '0.1', 1.5, new BigNumber('1.5')])('rejects a fractional number of drops: %s', (drops) => {
    expect(() => dropsToNative(drops)).toThrow(/too many decimal places/);
  });

  it.each(['', 'abc', 'NaN', 'Infinity', undefined as unknown as string, NaN])('rejects %p', (drops) => {
    expect(() => dropsToNative(drops)).toThrow(/dropsToNative/);
  });

  it('matches xrpl dropsToXrp', () => {
    const inputs: (string | number | BigNumber)[] = [
      '0',
      '1',
      '15',
      '1000000',
      '1000001',
      '45000000000000',
      '99999999999999999',
      '-5',
      7,
      1234567,
      new BigNumber('42'),
    ];
    for (const input of inputs) expect(dropsToNative(input)).toBe(dropsToXrp(input));
  });
});
