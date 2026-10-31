import { deepFreeze } from '../../../../packages/shared/src/test-utils/deep-freeze';
import { buildCountries, COUNTRIES_KEYS, COUNTRY_KEYS, UNKNOWN_KEYS } from './countries-object';
import type { Directory, DirectoryEntry } from './directory';

const BUILT_AT = Date.UTC(2026, 9, 24, 15, 42, 53, 2);

const entry = (key: string, over: Partial<DirectoryEntry>): DirectoryEntry =>
  ({ key, unl: false, unlLists: [], seen24h: false, listed: true, ...over }) as DirectoryEntry;
const directoryOf = (...ordered: DirectoryEntry[]) =>
  deepFreeze({ ordered, builtAt: BUILT_AT }) as Pick<Directory, 'ordered' | 'builtAt'>;

const FLEET = directoryOf(
  entry('nH1', { unl: true, serverCountry: 'US' }),
  entry('nH2', { unl: true, serverCountry: 'DE' }),
  entry('nH3', { unl: true, serverCountry: 'DE' }),
  entry('nH4', { seen24h: true, serverCountry: 'DE' }),
  entry('nH5', { seen24h: true, serverCountry: 'US' }),
  entry('nH6', { seen24h: true, serverCountry: 'US' }),
  entry('nH7', { seen24h: true, serverCountry: 'FI' }),
  entry('nH8', { unl: true }),
  entry('nH9', { seen24h: true }),
  // listed, but in neither scope
  entry('nHA', { serverCountry: 'NO' }),
);

describe('buildCountries', () => {
  it('counts both scopes', () => {
    expect(buildCountries(FLEET, 'unl')).toEqual({
      result: 'success',
      scope: 'unl',
      validators: 4,
      unl: 4,
      located: 3,
      unknown: { validators: 1, unl: 1 },
      count: 2,
      countries: [
        { country: 'DE', validators: 2, unl: 2 },
        { country: 'US', validators: 1, unl: 1 },
      ],
      updated: '2026-10-24T15:42:53.002Z',
    });
    expect(buildCountries(FLEET, 'all')).toMatchObject({
      scope: 'all',
      validators: 9,
      unl: 4,
      located: 7,
      unknown: { validators: 2, unl: 1 },
      count: 3,
    });
  });

  it('orders by validators, then unl, then code', () => {
    const { countries } = buildCountries(
      directoryOf(
        entry('a', { seen24h: true, serverCountry: 'FI' }),
        entry('b', { unl: true, serverCountry: 'SE' }),
        entry('c', { seen24h: true, serverCountry: 'AT' }),
        entry('d', { seen24h: true, serverCountry: 'US' }),
        entry('e', { seen24h: true, serverCountry: 'US' }),
      ),
      'all',
    );
    expect(countries.map((c) => c.country)).toEqual(['US', 'SE', 'AT', 'FI']);
  });

  it('adds located and unknown up to validators', () => {
    for (const scope of ['unl', 'all'] as const) {
      const body = buildCountries(FLEET, scope);
      expect(body.located + body.unknown.validators).toBe(body.validators);
      expect(body.countries.reduce((sum, c) => sum + c.validators, 0)).toBe(body.located);
    }
  });

  it('counts the UNL members of each country and of unknown', () => {
    const body = buildCountries(FLEET, 'all');
    expect(body.countries).toEqual([
      { country: 'DE', validators: 3, unl: 2 },
      { country: 'US', validators: 3, unl: 1 },
      { country: 'FI', validators: 1, unl: 0 },
    ]);
    expect(body.unknown).toEqual({ validators: 2, unl: 1 });
  });

  it('answers an empty directory with zeros and no country', () => {
    expect(buildCountries(directoryOf(), 'unl')).toEqual({
      result: 'success',
      scope: 'unl',
      validators: 0,
      unl: 0,
      located: 0,
      unknown: { validators: 0, unl: 0 },
      count: 0,
      countries: [],
      updated: '2026-10-24T15:42:53.002Z',
    });
  });

  it('lists its keys in the order of the constants', () => {
    const body = buildCountries(FLEET, 'unl');
    expect(Object.keys(body)).toEqual([...COUNTRIES_KEYS]);
    expect(Object.keys(body.countries[0])).toEqual([...COUNTRY_KEYS]);
    expect(Object.keys(body.unknown)).toEqual([...UNKNOWN_KEYS]);
    expect([...COUNTRIES_KEYS]).toEqual([
      'result',
      'scope',
      'validators',
      'unl',
      'located',
      'unknown',
      'count',
      'countries',
      'updated',
    ]);
    expect([...COUNTRY_KEYS]).toEqual(['country', 'validators', 'unl']);
    expect([...UNKNOWN_KEYS]).toEqual(['validators', 'unl']);
  });
});
