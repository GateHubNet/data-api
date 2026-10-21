import BigNumber from 'bignumber.js';
import { ammShareText } from './markets-live.job';

describe('ammShareText', () => {
  const share = (part: BigNumber.Value, whole: BigNumber.Value): string | null =>
    ammShareText(new BigNumber(part), new BigNumber(whole));

  it('is the part over the whole with exactly 4 decimals', () => {
    expect(share(34, 100)).toBe('0.3400');
    expect(share(5, 5)).toBe('1.0000');
    expect(share(0, 7)).toBe('0.0000');
  });

  it('rounds half up, once, on the exact quotient', () => {
    expect(share(1, 3)).toBe('0.3333');
    expect(share(2, 3)).toBe('0.6667');
    expect(share('0.00005', 1)).toBe('0.0001');
    expect(share('0.000049', 1)).toBe('0.0000');
    // a quotient a hair below the half: a rounding to more places first would carry it up to 0.0001
    expect(share('0.0000499999999999999999999999', 1)).toBe('0.0000');
  });

  it('is null when the whole is not above 0', () => {
    expect(share(1, 0)).toBeNull();
    expect(share(0, 0)).toBeNull();
  });
});
