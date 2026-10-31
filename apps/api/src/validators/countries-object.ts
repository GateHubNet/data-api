import type { Directory } from './directory';
import { instant } from './summary-object';
import { inScope, Scope } from './validators-query';

/*
 * The answer of `GET /v2/network/validators/countries` (D8 4.4). Pure, over the directory the list reads: every count is what the
 * list gives with the same `scope` and `country`.
 */

/** The keys of the answer, in order. */
export const COUNTRIES_KEYS = [
  'result',
  'scope',
  'validators',
  'unl',
  'located',
  'unknown',
  'count',
  'countries',
  'updated',
] as const;

/** The keys of a country, in order. */
export const COUNTRY_KEYS = ['country', 'validators', 'unl'] as const;

/** The keys of `unknown`, in order. */
export const UNKNOWN_KEYS = ['validators', 'unl'] as const;

export interface CountriesBody {
  result: 'success';
  scope: Scope;
  validators: number;
  unl: number;
  located: number;
  unknown: { validators: number; unl: number };
  count: number;
  countries: { country: string; validators: number; unl: number }[];
  updated: string;
}

/** The validators of a scope per server country: `validators` desc, then `unl` desc, then the code. */
export function buildCountries(directory: Pick<Directory, 'ordered' | 'builtAt'>, scope: Scope): CountriesBody {
  const counts = new Map<string, { validators: number; unl: number }>();
  const unknown = { validators: 0, unl: 0 };
  let validators = 0;
  let unl = 0;
  for (const entry of directory.ordered) {
    if (!inScope(entry, scope)) continue;
    validators += 1;
    if (entry.unl) unl += 1;
    let tally = unknown;
    if (entry.serverCountry !== undefined) {
      tally = counts.get(entry.serverCountry) ?? { validators: 0, unl: 0 };
      counts.set(entry.serverCountry, tally);
    }
    tally.validators += 1;
    if (entry.unl) tally.unl += 1;
  }
  const countries = [...counts]
    .map(([country, tally]) => ({ country, validators: tally.validators, unl: tally.unl }))
    .sort(
      (a, b) =>
        b.validators - a.validators || b.unl - a.unl || (a.country < b.country ? -1 : a.country > b.country ? 1 : 0),
    );
  return {
    result: 'success',
    scope,
    validators,
    unl,
    located: validators - unknown.validators,
    unknown,
    count: countries.length,
    countries,
    updated: instant(directory.builtAt / 1000),
  };
}
