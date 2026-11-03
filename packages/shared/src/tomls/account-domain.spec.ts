import { accountDomainOf, MAX_DOMAIN_HEX } from './account-domain';

const hex = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

describe('accountDomainOf', () => {
  it('reads the Domain field as lower case text', () =>
    expect(accountDomainOf('4578616D706C652E434F4D')).toBe('example.com'));

  it('accepts lower case hex digits', () =>
    expect(accountDomainOf(hex('example.com').toLowerCase())).toBe('example.com'));

  it('accepts a domain of 128 characters and refuses one of 129', () => {
    const at128 = `${'a'.repeat(63)}.${'b'.repeat(60)}.com`;
    const at129 = `${'a'.repeat(63)}.${'b'.repeat(61)}.com`;
    expect(at128).toHaveLength(128);
    expect(at129).toHaveLength(129);
    expect(accountDomainOf(hex(at128))).toBe(at128);
    expect(accountDomainOf(hex(at129))).toBeUndefined();
  });

  it('names no domain for a URL, a path, a port, an IP, an IPFS hash, a space or non-ASCII', () => {
    const texts = [
      'https://x.com',
      'x.com/path',
      'x.com:443',
      'localhost',
      '1.2.3.4',
      'ex ample.com',
      ' example.com',
      'ex\u00E4mple.com',
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    ];
    for (const text of texts) expect([text, accountDomainOf(hex(text))]).toEqual([text, undefined]);
  });

  it('trims nothing: a trailing space or control byte is no domain', () =>
    expect([accountDomainOf(hex('example.com ')), accountDomainOf(hex('example.com\n'))]).toEqual([
      undefined,
      undefined,
    ]));

  it('names no domain for hex that is empty, of odd length, not hex, or longer than the field', () => {
    expect(MAX_DOMAIN_HEX).toBe(512);
    expect([
      accountDomainOf(''),
      accountDomainOf('ABC'),
      accountDomainOf('ZZ'),
      accountDomainOf('41'.repeat(MAX_DOMAIN_HEX / 2 + 1)),
    ]).toEqual([undefined, undefined, undefined, undefined]);
    expect('41'.repeat(MAX_DOMAIN_HEX / 2 + 1)).toHaveLength(514);
  });
});
