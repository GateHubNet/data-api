import { RippleHttpError } from '../common/errors';
import { decodeHoldersMarker, encodeHoldersMarker } from './token-holders.service';

const markerOf = (key: unknown): string => Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
const HOLDER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

function badMarker(marker: string): void {
  try {
    decodeHoldersMarker(marker);
  } catch (e) {
    expect(e).toBeInstanceOf(RippleHttpError);
    expect((e as RippleHttpError).getStatus()).toBe(400);
    expect((e as RippleHttpError).getResponse()).toEqual({ result: 'error', message: 'invalid marker' });
    return;
  }
  throw new Error(`${marker} is a marker`);
}

describe('the marker of the holders', () => {
  it('is the Float64 balance and the holder of the last row', () => {
    expect(JSON.parse(Buffer.from(encodeHoldersMarker(21_395_768.51, HOLDER), 'base64url').toString('utf8'))).toEqual([
      21_395_768.51,
      HOLDER,
    ]);
  });

  it('reads back the double it wrote: the shortest text of a double is the same double', () => {
    for (const balance of [0.1 + 0.2, 0.3, 9007199254740992, 1e21, 1.5e-7, 123456789.12345679, Number.MIN_VALUE]) {
      const [back, holder] = decodeHoldersMarker(encodeHoldersMarker(balance, HOLDER)) ?? [];
      expect([Object.is(back, balance), holder]).toEqual([true, HOLDER]);
    }
  });

  it('is none for the first page: no marker, or an empty one', () => {
    expect(decodeHoldersMarker(undefined)).toBeUndefined();
    expect(decodeHoldersMarker('')).toBeUndefined();
  });

  it.each([
    ['text that is not base64url', '%%'],
    ['JSON that is not an array', markerOf({ balance: 1, holder: HOLDER })],
    ['a single value', markerOf([1.5])],
    ['three values', markerOf([1.5, HOLDER, 'x'])],
    ['the balance as text', markerOf(['1.5', HOLDER])],
    ['a balance that is null', markerOf([null, HOLDER])],
    ['a holder that is a number', markerOf([1.5, 7])],
    ['a holder that is null', markerOf([1.5, null])],
    ['the marker of the list of tokens', markerOf(['issued', 60, HOLDER, 'USD'])],
  ])('%s is invalid marker', (_, marker) => {
    badMarker(marker);
  });
});
