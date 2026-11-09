import { encodeAccountID } from 'ripple-address-codec';
import { RippleHttpError } from '../common/errors';
import { parseExclude } from './exclude-param';

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const address = (i: number): string => encodeAccountID(Buffer.alloc(20, i));

function badRequestMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RippleHttpError);
    expect((e as RippleHttpError).getStatus()).toBe(400);
    return ((e as RippleHttpError).getResponse() as { message: string }).message;
  }
  throw new Error('expected the call to throw');
}

describe('parseExclude', () => {
  it('is undefined when missing or empty', () => {
    expect(parseExclude({})).toBeUndefined();
    expect(parseExclude({ exclude: '' })).toBeUndefined();
  });

  it('exclude ignores duplicates and accepts the issuer', () => {
    const [a, b] = [address(2), address(1)];
    expect(parseExclude({ exclude: `${a},${ISSUER},${b},${a}` })).toEqual([a, ISSUER, b].sort());
  });

  it('20 distinct addresses are accepted, also with repeats beyond them', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => address(i + 1));
    expect(parseExclude({ exclude: [...twenty, twenty[0]].join(',') })).toHaveLength(20);
  });

  it('21 addresses is too many addresses to exclude', () => {
    const many = Array.from({ length: 21 }, (_, i) => address(i + 1)).join(',');
    expect(badRequestMessage(() => parseExclude({ exclude: many }))).toBe('too many addresses to exclude');
  });

  it('an address that is none, an empty element too, is invalid ripple address', () => {
    expect(badRequestMessage(() => parseExclude({ exclude: `${ISSUER},nobody` }))).toBe('invalid ripple address');
    expect(badRequestMessage(() => parseExclude({ exclude: `${ISSUER},,${address(1)}` }))).toBe(
      'invalid ripple address',
    );
  });
});
