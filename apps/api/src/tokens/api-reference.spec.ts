import { TOKEN_TOML_KEYS } from '@gatehub/data-api-shared';
import { readFileSync } from 'node:fs';
import {
  bodyOrderOf,
  examplesOf,
  examplesProblemsOf,
  fenceProblems,
  hasOwn,
  Json,
  partOf,
  REFERENCE,
  referenceChecks,
} from '../../test/support/api-reference-check';
import { COVERAGE_FEATURES } from '../common/coverage-features';
import * as featureCoverage from '../common/feature-coverage.service';
import { COVERAGE_KEYS } from '../common/feature-coverage.service';
import * as tokenList from './token-list';
import { TOKEN_KINDS, TOKEN_LIST_KEYS } from './token-list';
import * as tokenObjects from './token-objects';
import {
  HOLDER_ROW_KEYS,
  HOLDERS_ANSWER_KEYS,
  ISSUED_TOKEN_ROW_KEYS,
  ISSUED_TOTALS_KEYS,
  ISSUER_SETTINGS_KEYS,
  TOKEN_ANSWER_KEYS,
  TOKEN_KEYS,
  TOKEN_MARKET_KEYS,
  TRANSFER_ROW_KEYS,
  TRANSFERS_ANSWER_KEYS,
} from './token-objects';

/*
 * The "Tokens" section of docs/api-reference.md names the keys of every object it documents, in order, on a line of the form
 *
 *   Keys of <object>, in order: `a, b?, c`.
 *
 * (a key that may be missing from an answer can be written `b?`). This spec ties each of those lines to the constant the code
 * serves the object by: the line is the reference, the constant is the code, and neither may drift from the other. When one
 * fails, fix the reference; a constant is pinned by the specs and the e2e suites of its route (`tokens.e2e-spec.ts`), and is never
 * changed to fit a line. The examples of the section are answers of those suites: their keys come in the order of the constants,
 * which the second half of the spec checks, so that an example cannot be edited out of the code's order either. The checks
 * themselves are in `test/support/api-reference-check.ts`.
 *
 * All of the four routes are documented in this one section, under a heading each.
 */

const HEADING = '## Tokens';

/** The keys of a token's toml entry, which `token-rules.ts` of the shared package owns (the objects module does not export them). */
const TOML_KEYS = TOKEN_TOML_KEYS;

/** The object as the reference names it on its line, and the constant that holds its keys. One entry for each constant of the routes. */
const OBJECTS: Record<string, readonly string[]> = {
  // every answer: the key after `result`
  'the coverage': COVERAGE_KEYS,
  // GET /v2/tokens
  'the list answer': TOKEN_LIST_KEYS,
  'the totals': ISSUED_TOTALS_KEYS,
  'an issued token row': ISSUED_TOKEN_ROW_KEYS,
  // GET /v2/tokens/{currency}.{issuer}
  'the token answer': TOKEN_ANSWER_KEYS,
  'a token': TOKEN_KEYS,
  toml: TOML_KEYS,
  issuer_settings: ISSUER_SETTINGS_KEYS,
  'a market': TOKEN_MARKET_KEYS,
  // GET /v2/tokens/{currency}.{issuer}/holders
  'the holders answer': HOLDERS_ANSWER_KEYS,
  'a holder': HOLDER_ROW_KEYS,
  // GET /v2/tokens/{currency}.{issuer}/transfers
  'the transfers answer': TRANSFERS_ANSWER_KEYS,
  'a transfer': TRANSFER_ROW_KEYS,
};

const { sectionOf, keyLines, problemsOf, lineOf: lineIn } = referenceChecks(HEADING, OBJECTS);

// -- the examples ----------------------------------------------------------------------------------------------------------

/** The constant the object under a key is served by; a list takes the key of its elements. A `holders` that is a number is no object. */
const KEYS_UNDER: Record<string, readonly string[]> = {
  coverage: COVERAGE_KEYS,
  totals: ISSUED_TOTALS_KEYS,
  tokens: ISSUED_TOKEN_ROW_KEYS,
  token: TOKEN_KEYS,
  toml: TOML_KEYS,
  issuer_settings: ISSUER_SETTINGS_KEYS,
  markets: TOKEN_MARKET_KEYS,
  holders: HOLDER_ROW_KEYS,
  transfers: TRANSFER_ROW_KEYS,
};

/**
 * The answers of the routes: each ends with the list or the object that tells it from the others. The list answer before a
 * generation exists is the same keys with fewer of them, and ends with the same list.
 */
const BODIES: readonly (readonly string[])[] = [
  TOKEN_LIST_KEYS,
  TOKEN_ANSWER_KEYS,
  HOLDERS_ANSWER_KEYS,
  TRANSFERS_ANSWER_KEYS,
];

describe('the "Tokens" section of docs/api-reference.md', () => {
  const markdown = readFileSync(REFERENCE, 'utf8');

  it.each(Object.entries(OBJECTS))('writes the keys of %s as the code serves them', (object, constant) => {
    const own = keyLines(markdown).filter((line) => line.object === object);
    expect(own).toHaveLength(1);
    expect(own[0].keys).toEqual([...constant]);
  });

  it('has no line for an object the map does not name, and none twice', () => {
    const names = keyLines(markdown).map((line) => line.object);
    expect(names.filter((name) => !hasOwn(OBJECTS, name))).toEqual([]);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
    expect(names).toHaveLength(Object.keys(OBJECTS).length);
  });

  it('is checked against every *_KEYS constant of the list, the objects and the coverage: none is left out of the map', () => {
    const exported = [tokenList, tokenObjects, featureCoverage].flatMap((module) =>
      Object.entries(module).filter(([name]) => name.endsWith('_KEYS')),
    );
    expect(exported.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'TOKEN_LIST_KEYS',
        'ISSUED_TOTALS_KEYS',
        'ISSUED_TOKEN_ROW_KEYS',
        'TOKEN_ANSWER_KEYS',
        'TOKEN_KEYS',
        'ISSUER_SETTINGS_KEYS',
        'TOKEN_MARKET_KEYS',
        'HOLDERS_ANSWER_KEYS',
        'HOLDER_ROW_KEYS',
        'TRANSFERS_ANSWER_KEYS',
        'TRANSFER_ROW_KEYS',
        'COVERAGE_KEYS',
      ]),
    );
    const mapped = new Set<unknown>(Object.values(OBJECTS));
    expect(exported.filter(([, value]) => !mapped.has(value)).map(([name]) => name)).toEqual([]);
    // the toml keys are the shared package's constant, and are in the map as well
    expect(mapped.has(TOKEN_TOML_KEYS)).toBe(true);
    // and no constant stands for two objects
    expect(mapped.size).toBe(Object.keys(OBJECTS).length);
  });

  it('has no problem', () => {
    expect(problemsOf(markdown)).toEqual([]);
  });

  it('closes every code block of its section on a line of its own', () => {
    expect(fenceProblems(sectionOf(markdown))).toEqual([]);
  });

  it('documents the four routes, each under a heading of its own, and links them from the Compatibility list of extras', () => {
    const section = sectionOf(markdown);
    for (const route of [
      'GET /v2/tokens',
      'GET /v2/tokens/{currency}.{issuer}',
      'GET /v2/tokens/{currency}.{issuer}/holders',
      'GET /v2/tokens/{currency}.{issuer}/transfers',
    ]) {
      expect([route, section.includes(`\n### \`${route}\`\n`)]).toEqual([route, true]);
    }
    const compatibility = partOf(markdown, '### Compatibility');
    for (const anchor of [
      '(#tokens)',
      '(#get-v2tokens)',
      '(#get-v2tokenscurrencyissuer)',
      '(#get-v2tokenscurrencyissuerholders)',
      '(#get-v2tokenscurrencyissuertransfers)',
    ]) {
      expect([anchor, compatibility.includes(anchor)]).toEqual([anchor, true]);
    }
    expect(partOf(markdown, '## Conventions')).toContain('[tokens](#tokens)');
  });

  it('writes the messages of the routes as the code answers them', () => {
    const section = sectionOf(markdown);
    for (const message of [
      `invalid kind - use: ${TOKEN_KINDS.join(', ')}`,
      'invalid min_holders',
      'invalid search',
      'invalid marker',
      'unable to retrieve tokens',
      'invalid currency',
      'XRP cannot have an issuer',
      'invalid issuer address',
      'token not found',
      'unable to retrieve token',
      'unable to retrieve holders',
      'invalid start date format',
      'invalid end date format',
      'unable to retrieve transfers',
    ]) {
      expect([message, section.includes(`\`${message}\``)]).toEqual([message, true]);
    }
    expect(section).toContain('`XAH` on Xahau');
  });

  it('names the two coverage features and the parser versions they are registered with', () => {
    const section = sectionOf(markdown);
    for (const feature of ['issued_tokens', 'token_transfers'] as const) {
      expect([feature, section.includes(`\`${feature}\``)]).toEqual([feature, true]);
    }
    const flat = section.replace(/\s+/g, ' ');
    expect(flat).toContain(`parser version ${COVERAGE_FEATURES.issued_tokens.parserVersion} or later`);
    expect(flat).toContain(`(parser version ${COVERAGE_FEATURES.token_transfers.parserVersion})`);
    // both start at the network's first ledger: 32,570 on the XRP Ledger, 1 on Xahau
    expect(COVERAGE_FEATURES.issued_tokens.startOf()).toEqual({ kind: 'first_ledger' });
    expect(COVERAGE_FEATURES.token_transfers.startOf()).toEqual({ kind: 'first_ledger' });
    expect(flat).toContain('**32,570** on the XRP Ledger, **1** on Xahau');
  });

  describe('its examples', () => {
    const examples = (): Json[] => examplesOf(sectionOf(markdown));

    it('are answers of the routes with their keys in the order of the code', () => {
      expect(examplesProblemsOf(examples(), BODIES, KEYS_UNDER)).toEqual([]);
    });

    it('include an answer of every route, a list with a marker and one with the count below, the answer before a generation, and the shapes of a token', () => {
      const all = examples();
      const bodies = all.map((example) => bodyOrderOf(example, BODIES));
      for (const body of BODIES) expect(bodies).toContain(body);
      const lists = all.filter((example) => bodyOrderOf(example, BODIES) === TOKEN_LIST_KEYS) as Record<string, Json>[];
      expect(lists.some((list) => hasOwn(list, 'marker'))).toBe(true);
      expect(lists.some((list) => hasOwn(list, 'total_below'))).toBe(true);
      // the answer before the first generation: no ledger, no totals, no tokens
      expect(lists.some((list) => list.count === 0 && !hasOwn(list, 'totals') && !hasOwn(list, 'ledger_index'))).toBe(
        true,
      );
      const text = JSON.stringify(all);
      expect(text).toContain('"kind":"issued"');
      expect(text).toContain('"complete":true');
      expect(text).toContain('"complete":false');
      // a token with markets, one with a toml, one with neither a toml nor the settings of its issuer
      const tokens = all
        .filter((example) => bodyOrderOf(example, BODIES) === TOKEN_ANSWER_KEYS)
        .map((example) => (example as { token: Record<string, Json> }).token);
      expect(tokens.some((token) => Array.isArray(token.markets) && token.markets.length > 0)).toBe(true);
      expect(tokens.some((token) => hasOwn(token, 'toml'))).toBe(true);
      expect(tokens.some((token) => !hasOwn(token, 'toml') && !hasOwn(token, 'issuer_settings'))).toBe(true);
      // a transfer with a destination tag of 0 (a tag is a tag), and a page with a marker
      expect(text).toContain('"destination_tag":0');
      const transfers = all.filter((example) => bodyOrderOf(example, BODIES) === TRANSFERS_ANSWER_KEYS);
      expect(transfers.some((page) => hasOwn(page as object, 'marker'))).toBe(true);
    });

    it('finds an example whose keys swapped places, and one that no answer has the keys of', () => {
      const holders = examples().find((example) => bodyOrderOf(example, BODIES) === HOLDERS_ANSWER_KEYS) as {
        coverage: Json;
        holders: Json;
      };
      expect(holders).toBeDefined();
      const swapped = { coverage: holders.coverage, result: 'success', holders: holders.holders };
      expect(examplesProblemsOf([swapped], BODIES, KEYS_UNDER)).toEqual([
        expect.stringMatching(/^example 1: coverage, result, holders is not in the order/),
      ]);
      expect(bodyOrderOf({ result: 'success', rows: [], extra: 1 }, BODIES)).toBeUndefined();
      expect(examplesProblemsOf([{ result: 'success', rows: [], extra: 1 }], BODIES, KEYS_UNDER)).toEqual([
        'example 1: no answer of the routes has the keys result, rows, extra',
      ]);
    });

    it('finds the keys of a token, of its toml and of a holder in another order than the code writes them', () => {
      const answer = examples().find((example) => bodyOrderOf(example, BODIES) === TOKEN_ANSWER_KEYS) as {
        token: Record<string, Json>;
      } & Record<string, Json>;
      expect(answer).toBeDefined();
      const { currency, code, ...rest } = answer.token;
      const reordered = { ...answer, token: { code, currency, ...rest } };
      expect(examplesProblemsOf([reordered], BODIES, KEYS_UNDER)).toEqual([
        expect.stringMatching(/^example 1\.token: code, currency, issuer, .* is not in the order/),
      ]);
      const holder = {
        rank: 1,
        holder: 'rA',
        share: '0.5',
        balance: '1',
        limit: '1',
        frozen: false,
        authorized: false,
      };
      const page = { result: 'success', coverage: { complete: true }, supply: '2', count: 1, holders: [holder] };
      expect(examplesProblemsOf([page], BODIES, KEYS_UNDER)).toEqual([
        expect.stringMatching(/^example 1\.holders\[0\]: rank, holder, share, balance, .* is not in the order/),
      ]);
    });
  });

  describe('the check itself', () => {
    const lineOf = (object: string): string => lineIn(markdown, object);

    it('finds a line whose keys swapped places', () => {
      const line = lineOf('a holder');
      const swapped = line.replace('`rank, holder,', '`holder, rank,');
      expect(swapped).not.toBe(line);
      expect(problemsOf(markdown.replace(line, swapped))).toEqual([expect.stringMatching(/^drifted: a holder /)]);
    });

    it('finds a line with a key added, and one with a key gone', () => {
      const line = lineOf('a transfer');
      expect(problemsOf(markdown.replace(line, line.replace(/\.$/, ', extra.')))).toEqual([
        expect.stringMatching(/^drifted: a transfer /),
      ]);
      expect(problemsOf(markdown.replace(line, line.replace(/, destination_tag\?`\.$/, '`.')))).toEqual([
        expect.stringMatching(/^drifted: a transfer /),
      ]);
    });

    it('finds a line that is missing, and one that is written twice', () => {
      const line = lineOf('a market');
      expect(problemsOf(markdown.replace(`${line}\n`, ''))).toEqual(['missing: no line for a market']);
      expect(problemsOf(markdown.replace(line, `${line}\n\n${line}`))).toEqual(['twice: 2 lines for a market']);
    });

    it('finds a line for an object nothing owns, and a line renamed', () => {
      const line = lineOf('the totals');
      expect(problemsOf(markdown.replace(line, line.replace('Keys of the totals,', 'Keys of the sums,')))).toEqual([
        'missing: no line for the totals',
        expect.stringMatching(/^unknown: a line for "the sums"/),
      ]);
    });

    it('reads an optional key written `key?` as the key', () => {
      const line = lineOf('a token');
      expect(problemsOf(markdown.replace(line, line.replace('`currency,', '`currency?,')))).toEqual([]);
    });

    it('does not read a line of another section', () => {
      expect(() => keyLines(markdown.replace('\n## Tokens\n', '\n## Other\n'))).toThrow('has no "## Tokens" heading');
      const outside = markdown.replace(
        '\n## Validations\n',
        '\n## Validations\n\nKeys of a ghost, in order: `a, b`.\n',
      );
      expect(outside).not.toBe(markdown);
      expect(problemsOf(outside)).toEqual([]);
    });
  });
});
