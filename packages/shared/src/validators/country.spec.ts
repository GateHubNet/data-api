import { countryCodeOf, ISO_COUNTRY_CODES } from './country';

describe('ISO_COUNTRY_CODES', () => {
  it('holds the 250 codes', () => {
    expect(ISO_COUNTRY_CODES.size).toBe(250);
    for (const code of ['US', 'DE', 'HK', 'XK', 'AQ']) expect(ISO_COUNTRY_CODES.has(code)).toBe(true);
    for (const code of ['UK', 'EU', 'ZZ', 'AA', 'QM', 'XA']) expect(ISO_COUNTRY_CODES.has(code)).toBe(false);
  });
});

describe('countryCodeOf', () => {
  it.each([
    ['us', 'US'],
    [' de ', 'DE'],
    ['UK', 'GB'],
    ['uk', 'GB'],
    ['XK', 'XK'],
  ])('reads %j as %s', (value, code) => {
    expect(countryCodeOf(value)).toBe(code);
  });

  it.each([['EU'], ['DEU'], ['Germany'], ['US-CA'], [''], [49], [null], [undefined]])('refuses %j', (value) => {
    expect(countryCodeOf(value)).toBeUndefined();
  });

  // `toUpperCase` folds each of these into a real code: South Sudan, Finland, Indonesia, Sweden
  it.each([['ß'], ['ﬁ'], ['ıd'], ['ſe']])('refuses %j, which upper-cases into a code', (value) => {
    expect(countryCodeOf(value)).toBeUndefined();
  });
});
