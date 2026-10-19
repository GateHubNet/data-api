import { getNetworkProfile } from './network-profile';
import { defaultUnlThreshold, parseUnlPublishers, publisherIdOf } from './unl-publishers';

const RIPPLE_KEY = 'ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734';
const XRPLF_KEY = 'ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1';
const XAHAU_KEY = 'EDA46E9C39B1389894E690E58914DC1029602870370A0993E5B87C4A24EAF4A8E8';
const HEX = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF'; // 64 digits

describe('parseUnlPublishers', () => {
  it('reads the default publishers of both networks', () => {
    expect(parseUnlPublishers(getNetworkProfile('xrpl').defaultUnlPublishers)).toEqual([
      { id: 'vl.ripple.com', url: 'https://vl.ripple.com', publicKey: RIPPLE_KEY },
      { id: 'unl.xrplf.org', url: 'https://unl.xrplf.org', publicKey: XRPLF_KEY },
    ]);
    expect(parseUnlPublishers(getNetworkProfile('xahau').defaultUnlPublishers)).toEqual([
      { id: 'vl.xahau.org', url: 'https://vl.xahau.org', publicKey: XAHAU_KEY },
    ]);
  });

  it('is empty for an empty text', () => {
    expect(parseUnlPublishers('')).toEqual([]);
    expect(parseUnlPublishers('   ')).toEqual([]);
    expect(parseUnlPublishers(' , ,')).toEqual([]);
  });

  it('returns the key in upper case, whatever its case', () => {
    expect(parseUnlPublishers(`https://vl.example.org=${RIPPLE_KEY.toLowerCase()}`)[0].publicKey).toBe(RIPPLE_KEY);
    expect(parseUnlPublishers(`https://vl.example.org=ed${RIPPLE_KEY.slice(2).toLowerCase()}`)[0].publicKey).toBe(
      RIPPLE_KEY,
    );
  });

  it('accepts the 02 and 03 prefixes of a secp256k1 key', () => {
    expect(parseUnlPublishers(`https://a.example=02${HEX.toLowerCase()}`)[0].publicKey).toBe(`02${HEX}`);
    expect(parseUnlPublishers(`https://b.example=03${HEX}`)[0].publicKey).toBe(`03${HEX}`);
  });

  it('splits an entry at the last "="', () => {
    expect(parseUnlPublishers(`https://example.org/vl?a=1&b=2=${RIPPLE_KEY}`)).toEqual([
      { id: 'example.org/vl?a=1&b=2', url: 'https://example.org/vl?a=1&b=2', publicKey: RIPPLE_KEY },
    ]);
  });

  it('trims the text, the entries and both sides of a pair, and skips empty entries', () => {
    expect(
      parseUnlPublishers(` https://a.example/ = ${RIPPLE_KEY} ,, https://b.example=${XRPLF_KEY} , `).map((p) => [
        p.id,
        p.url,
      ]),
    ).toEqual([
      ['a.example', 'https://a.example/'],
      ['b.example', 'https://b.example'],
    ]);
  });

  it('keeps the order of the entries', () => {
    const text = `https://b.example=${XRPLF_KEY},https://a.example=${RIPPLE_KEY}`;
    expect(parseUnlPublishers(text).map((p) => p.id)).toEqual(['b.example', 'a.example']);
  });

  describe('refuses, naming the entry by its position', () => {
    const good = `https://a.example=${RIPPLE_KEY}`;

    it('an entry without "="', () => {
      expect(() => parseUnlPublishers('https://vl.ripple.com')).toThrow(/^GH_UNL_PUBLISHERS entry 1: /);
      expect(() => parseUnlPublishers(`${good},${RIPPLE_KEY}`)).toThrow(/^GH_UNL_PUBLISHERS entry 2: /);
    });

    it('a URL that is not https', () => {
      expect(() => parseUnlPublishers(`http://vl.ripple.com=${RIPPLE_KEY}`)).toThrow(
        /^GH_UNL_PUBLISHERS entry 1: .*https/,
      );
      expect(() => parseUnlPublishers(`${good},http://b.example=${XRPLF_KEY}`)).toThrow(/^GH_UNL_PUBLISHERS entry 2: /);
      expect(() => parseUnlPublishers(`ftp://vl.ripple.com=${RIPPLE_KEY}`)).toThrow(/^GH_UNL_PUBLISHERS entry 1: /);
      expect(() => parseUnlPublishers(`vl.ripple.com=${RIPPLE_KEY}`)).toThrow(/^GH_UNL_PUBLISHERS entry 1: /);
      expect(() => parseUnlPublishers(`=${RIPPLE_KEY}`)).toThrow(/^GH_UNL_PUBLISHERS entry 1: /);
      expect(() => parseUnlPublishers(`https://=${RIPPLE_KEY}`)).toThrow(/^GH_UNL_PUBLISHERS entry 1: /);
    });

    it('a key with the prefix 04', () => {
      expect(() => parseUnlPublishers(`https://a.example=04${HEX}`)).toThrow(/^GH_UNL_PUBLISHERS entry 1: .*key/);
    });

    it('a key of 64 digits, or of any other length', () => {
      expect(() => parseUnlPublishers(`https://a.example=${HEX}`)).toThrow(/^GH_UNL_PUBLISHERS entry 1: .*key/);
      expect(() => parseUnlPublishers(`https://a.example=ED${HEX.slice(1)}`)).toThrow(/entry 1: .*key/); // 65
      expect(() => parseUnlPublishers(`https://a.example=ED${HEX}0`)).toThrow(/entry 1: .*key/); // 67
      expect(() => parseUnlPublishers(`https://a.example=`)).toThrow(/entry 1: .*key/);
    });

    it('a key that is not hex', () => {
      expect(() => parseUnlPublishers(`https://a.example=ED${HEX.slice(0, 63)}G`)).toThrow(/entry 1: .*key/);
    });

    it('a URL listed twice, also with or without the trailing slash', () => {
      expect(() => parseUnlPublishers(`${good},https://a.example=${XRPLF_KEY}`)).toThrow(
        /^GH_UNL_PUBLISHERS entry 2: /,
      );
      expect(() => parseUnlPublishers(`${good},https://a.example/=${XRPLF_KEY}`)).toThrow(
        /^GH_UNL_PUBLISHERS entry 2: /,
      );
    });

    it('a key listed twice, also in another case', () => {
      expect(() => parseUnlPublishers(`${good},https://b.example=${RIPPLE_KEY}`)).toThrow(
        /^GH_UNL_PUBLISHERS entry 2: /,
      );
      expect(() => parseUnlPublishers(`${good},https://b.example=${RIPPLE_KEY.toLowerCase()}`)).toThrow(
        /^GH_UNL_PUBLISHERS entry 2: /,
      );
    });
  });
});

describe('publisherIdOf', () => {
  it('is the URL without the scheme and the trailing slash', () => {
    expect(publisherIdOf('https://vl.ripple.com/')).toBe('vl.ripple.com');
    expect(publisherIdOf('https://vl.ripple.com')).toBe('vl.ripple.com');
    expect(publisherIdOf('https://unl.xrplf.org')).toBe('unl.xrplf.org');
    expect(publisherIdOf('https://example.org/lists/vl/')).toBe('example.org/lists/vl');
    expect(publisherIdOf('https://example.org:8443//')).toBe('example.org:8443');
  });
});

describe('defaultUnlThreshold', () => {
  it('is 1 below three publishers, else half plus one', () => {
    expect([1, 2, 3, 4].map(defaultUnlThreshold)).toEqual([1, 1, 2, 3]);
    expect([0, 5, 6].map(defaultUnlThreshold)).toEqual([1, 3, 4]);
  });
});
