import BigNumber from 'bignumber.js';
import { EDGE_AMOUNTS, generatedAmount, seededRandom } from '../test-utils/token-history-cases';
import { compareOrderKeys, orderKeyOf } from './order-key';

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

describe('orderKeyOf', () => {
  it('orders like BigNumber over generated amounts', () => {
    const rnd = seededRandom(81);
    const amounts = [...EDGE_AMOUNTS, ...Array.from({ length: 2_000 }, () => generatedAmount(rnd))];
    // the edge amounts as the parser writes them too (plain text), and a few that tie on a double
    amounts.push(new BigNumber('1e-81').toFixed(), new BigNumber('9.999999999999999e80').toFixed(), '0.1', '0.10');
    const keys = amounts.map((a) => orderKeyOf(a, 'issued'));
    const wrong: Array<{ a: string; b: string; got: number; want: number | null }> = [];
    for (let i = 0; i < amounts.length; i++) {
      for (let j = i + 1; j < amounts.length; j += 7) {
        const want = new BigNumber(amounts[i]).comparedTo(amounts[j]);
        const got = sign(compareOrderKeys(keys[i], keys[j]));
        if (got !== want) wrong.push({ a: amounts[i], b: amounts[j], got, want });
      }
    }
    expect(wrong).toEqual([]);
    // the two that tie as doubles do not tie here
    expect(compareOrderKeys(orderKeyOf('9007199254740992', 'issued'), orderKeyOf('9007199254740993', 'issued'))).toBeLessThan(
      0,
    );
  });

  it('normalises the mantissa to [10^15, 10^16), and 0 to the lowest key', () => {
    expect(orderKeyOf('1250.75', 'issued')).toEqual({ exp: -12, mant: 1250750000000000n });
    expect(orderKeyOf('1e-81', 'issued')).toEqual({ exp: -96, mant: 1000000000000000n });
    expect(orderKeyOf('9.999999999999999e80', 'issued')).toEqual({ exp: 65, mant: 9999999999999999n });
    expect(orderKeyOf('0', 'issued')).toEqual({ exp: -32768, mant: 0n });
  });

  it('rejects 17 significant digits', () => {
    expect(() => orderKeyOf('12345678901234567', 'issued')).toThrow(
      new RangeError('amount has more than 16 significant digits'),
    );
    expect(() => orderKeyOf('1.2345678901234567e-40', 'issued')).toThrow(RangeError);
  });

  it('MPT keys order as integers up to 18446744073709551614', () => {
    const rnd = seededRandom(64);
    const amounts = ['0', '1', '9007199254740992', '9007199254740993', '9223372036854775807', '18446744073709551614'];
    for (let i = 0; i < 500; i++) {
      amounts.push((BigInt(Math.floor(rnd() * 2 ** 32)) * BigInt(Math.floor(rnd() * 2 ** 32))).toString());
    }
    for (const a of amounts) expect(orderKeyOf(a, 'mpt')).toEqual({ exp: 0, mant: BigInt(a) });
    const wrong: Array<{ a: string; b: string }> = [];
    for (let i = 0; i < amounts.length; i++) {
      for (let j = 0; j < amounts.length; j += 13) {
        const want = BigInt(amounts[i]) < BigInt(amounts[j]) ? -1 : BigInt(amounts[i]) > BigInt(amounts[j]) ? 1 : 0;
        if (sign(compareOrderKeys(orderKeyOf(amounts[i], 'mpt'), orderKeyOf(amounts[j], 'mpt'))) !== want) {
          wrong.push({ a: amounts[i], b: amounts[j] });
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
