import { mptIssuanceId } from '@gatehub/data-api-shared';
import { RippleHttpError } from '../common/errors';
import { parseAnyToken } from './token-history-param';

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const OTHER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const ID = mptIssuanceId(7, ISSUER);

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

describe('parseAnyToken', () => {
  it('reads an issued token as D6 does', () => {
    expect(parseAnyToken(`USD.${ISSUER}`, 'XRP')).toEqual({ kind: 'issued', currency: 'USD', issuer: ISSUER });
    expect(parseAnyToken(`usd+${ISSUER}`, 'XRP')).toEqual({ kind: 'issued', currency: 'USD', issuer: ISSUER });
    expect(badRequestMessage(() => parseAnyToken(`USD.${'x'}`, 'XRP'))).toBe('invalid issuer address');
    expect(badRequestMessage(() => parseAnyToken(`XRP.${ISSUER}`, 'XRP'))).toBe('XRP cannot have an issuer');
  });

  it('reads 48 hex digits as an MPT, its issuer from the ID', () => {
    expect(parseAnyToken(ID, 'XRP')).toEqual({ kind: 'mpt', currency: ID, issuer: ISSUER });
  });

  it('an issuance ID in lower case is accepted', () => {
    expect(parseAnyToken(ID.toLowerCase(), 'XRP')).toEqual({ kind: 'mpt', currency: ID, issuer: ISSUER });
    expect(parseAnyToken(`${ID.toLowerCase()}+${ISSUER}`, 'XRP')).toEqual({
      kind: 'mpt',
      currency: ID,
      issuer: ISSUER,
    });
  });

  it('a wrong issuer is issuer does not match mpt issuance', () => {
    expect(badRequestMessage(() => parseAnyToken(`${ID}+${OTHER}`, 'XRP'))).toBe('issuer does not match mpt issuance');
    expect(badRequestMessage(() => parseAnyToken(`${ID}+nobody`, 'XRP'))).toBe('invalid issuer address');
  });
});
