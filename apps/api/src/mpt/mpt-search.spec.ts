import { mptSearchOf } from './mpt-search';

describe('mptSearchOf', () => {
  const ADDRESS = 'rERShrtUSEXkrwtTpugPV4v8E787vpx1kb';
  const ID = '0598F6E09E30A809E63A1F02DE789586D2F4FDA9EF5200E3';

  it('reads a classic address as the issuer', () => {
    expect(mptSearchOf(ADDRESS)).toEqual({ by: 'issuer', issuer: ADDRESS });
  });

  it('reads 48 hex digits, in either case, as the ID in upper case', () => {
    expect(mptSearchOf(ID)).toEqual({ by: 'id', id: ID });
    expect(mptSearchOf(ID.toLowerCase())).toEqual({ by: 'id', id: ID });
  });

  it('reads 8 or more hex digits as text with a prefix of an ID, in upper case', () => {
    expect(mptSearchOf('0000012A')).toEqual({ by: 'text', text: '0000012A', idPrefix: '0000012A' });
    expect(mptSearchOf('0000012a')).toEqual({ by: 'text', text: '0000012a', idPrefix: '0000012A' });
    // 47 and 49 digits are a prefix (and no ID) and no ID at all
    expect(mptSearchOf(ID.slice(0, 47))).toEqual({ by: 'text', text: ID.slice(0, 47), idPrefix: ID.slice(0, 47) });
  });

  it('reads anything else as text, with no prefix', () => {
    expect(mptSearchOf('0000012')).toEqual({ by: 'text', text: '0000012' });
    expect(mptSearchOf('HTF')).toEqual({ by: 'text', text: 'HTF' });
    expect(mptSearchOf('rERS')).toEqual({ by: 'text', text: 'rERS' });
    // not hex, 8 characters
    expect(mptSearchOf('0000012G')).toEqual({ by: 'text', text: '0000012G' });
  });
});
