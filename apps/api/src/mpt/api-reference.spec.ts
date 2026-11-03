import { MPT_METADATA_KEYS, MPT_URI_KEYS } from '@gatehub/data-api-shared';
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
import { COVERAGE_KEYS } from '../common/feature-coverage.service';
import { TOKEN_KINDS, TOKEN_LIST_KEYS } from '../tokens/token-list';
import * as mptObjects from './mpt-objects';
import {
  ACCOUNT_MPT_BODY_KEYS,
  ACCOUNT_MPT_KEYS,
  MPT_FLAGS_KEYS,
  MPT_HOLDER_KEYS,
  MPT_HOLDERS_BODY_KEYS,
  MPT_ISSUANCE_BODY_KEYS,
  MPT_ISSUANCE_KEYS,
  MPT_LOOKUP_BODY_KEYS,
  MPT_SUMMARY_KEYS,
  MPT_TOKEN_ROW_KEYS,
  MPT_TOKENS_TOTALS_KEYS,
  MPT_TRANSFER_KEYS,
  MPT_TRANSFER_KINDS,
  MPT_TRANSFERS_BODY_KEYS,
} from './mpt-objects';

/*
 * The "MPT" section of docs/api-reference.md names the keys of every object it documents, in order, on a line of the form
 *
 *   Keys of <object>, in order: `a, b?, c`.
 *
 * (a key that may be missing from an answer can be written `b?`). This spec ties each of those lines to the constant the code
 * serves the object by: the line is the reference, the constant is the code, and neither may drift from the other. When one
 * fails, fix the reference; a constant is pinned by the specs and the e2e suites of its route (`mpt.e2e-spec.ts`,
 * `tokens-mpt.e2e-spec.ts`, `account-mpt.e2e-spec.ts`), and is never changed to fit a line. The examples of the section are answers
 * of the world of those suites, which `test/api-reference-examples.e2e-spec.ts` checks value by value; their keys come in the order
 * of the constants, which the second half of this spec checks without a database. The checks themselves are in
 * `test/support/api-reference-check.ts`.
 *
 * All of the six routes are documented in this one section, `kind=mpt` and the holdings of an account too, each under a heading of its
 * own: `## Tokens` and `## Accounts` hold a link (ruling C24).
 */

const HEADING = '## MPT';

/** The object as the reference names it on its line, and the constant that holds its keys. One entry for each constant of the routes. */
const OBJECTS: Record<string, readonly string[]> = {
  // GET /v2/mpt/{issuanceId}
  'the issuance answer': MPT_ISSUANCE_BODY_KEYS,
  'an issuance': MPT_ISSUANCE_KEYS,
  flags: MPT_FLAGS_KEYS,
  metadata: MPT_METADATA_KEYS,
  'an item of uris': MPT_URI_KEYS,
  // GET /v2/mpt?ids=
  'the lookup answer': MPT_LOOKUP_BODY_KEYS,
  'an issuance summary': MPT_SUMMARY_KEYS,
  // GET /v2/mpt/{issuanceId}/holders
  'the holders answer': MPT_HOLDERS_BODY_KEYS,
  'a holder': MPT_HOLDER_KEYS,
  // GET /v2/mpt/{issuanceId}/transfers
  'the transfers answer': MPT_TRANSFERS_BODY_KEYS,
  'a transfer': MPT_TRANSFER_KEYS,
  // GET /v2/tokens?kind=mpt
  'an MPT row': MPT_TOKEN_ROW_KEYS,
  'the MPT totals': MPT_TOKENS_TOTALS_KEYS,
  // GET /v2/accounts/{address}/mpt
  'the MPT holdings answer': ACCOUNT_MPT_BODY_KEYS,
  'a holding': ACCOUNT_MPT_KEYS,
};

const { sectionOf, keyLines, problemsOf, lineOf: lineIn } = referenceChecks(HEADING, OBJECTS);

// -- the examples ----------------------------------------------------------------------------------------------------------

/** The constant the object under a key is served by; a list takes the key of its elements. A `holders` that is a number is no object. */
const KEYS_UNDER: Record<string, readonly string[]> = {
  coverage: COVERAGE_KEYS,
  issuance: MPT_ISSUANCE_KEYS,
  flags: MPT_FLAGS_KEYS,
  metadata: MPT_METADATA_KEYS,
  uris: MPT_URI_KEYS,
  issuances: MPT_SUMMARY_KEYS,
  holders: MPT_HOLDER_KEYS,
  transfers: MPT_TRANSFER_KEYS,
  totals: MPT_TOKENS_TOTALS_KEYS,
  tokens: MPT_TOKEN_ROW_KEYS,
  mpt: ACCOUNT_MPT_KEYS,
};

/** The answers of the routes: each ends with the list or the object that tells it from the others. `kind=mpt` is D6's envelope. */
const BODIES: readonly (readonly string[])[] = [
  MPT_ISSUANCE_BODY_KEYS,
  MPT_LOOKUP_BODY_KEYS,
  MPT_HOLDERS_BODY_KEYS,
  MPT_TRANSFERS_BODY_KEYS,
  TOKEN_LIST_KEYS,
  ACCOUNT_MPT_BODY_KEYS,
];

/** A text with its line breaks as spaces: a sentence of the reference can wrap anywhere. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('the "MPT" section of docs/api-reference.md', () => {
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

  it('is checked against every *_KEYS constant of the objects: none is left out of the map', () => {
    const exported = Object.entries(mptObjects).filter(([name]) => name.endsWith('_KEYS'));
    expect(exported.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'MPT_ISSUANCE_BODY_KEYS',
        'MPT_ISSUANCE_KEYS',
        'MPT_FLAGS_KEYS',
        'MPT_LOOKUP_BODY_KEYS',
        'MPT_SUMMARY_KEYS',
        'MPT_HOLDERS_BODY_KEYS',
        'MPT_HOLDER_KEYS',
        'MPT_TRANSFERS_BODY_KEYS',
        'MPT_TRANSFER_KEYS',
        'MPT_TOKEN_ROW_KEYS',
        'MPT_TOKENS_TOTALS_KEYS',
        'ACCOUNT_MPT_BODY_KEYS',
        'ACCOUNT_MPT_KEYS',
      ]),
    );
    const mapped = new Set<unknown>(Object.values(OBJECTS));
    expect(exported.filter(([, value]) => !mapped.has(value)).map(([name]) => name)).toEqual([]);
    // the metadata's keys are the shared package's constants, and are in the map as well
    expect(mapped.has(MPT_METADATA_KEYS)).toBe(true);
    expect(mapped.has(MPT_URI_KEYS)).toBe(true);
    // and no constant stands for two objects
    expect(mapped.size).toBe(Object.keys(OBJECTS).length);
  });

  it('has no problem', () => {
    expect(problemsOf(markdown)).toEqual([]);
  });

  it('closes every code block of its section on a line of its own', () => {
    expect(fenceProblems(sectionOf(markdown))).toEqual([]);
  });

  it('documents the six routes, each under a heading of its own, and links them from the Compatibility list of extras', () => {
    const section = sectionOf(markdown);
    for (const route of [
      'GET /v2/mpt/{issuanceId}',
      'GET /v2/mpt?ids=',
      'GET /v2/mpt/{issuanceId}/holders',
      'GET /v2/mpt/{issuanceId}/transfers',
      'GET /v2/tokens?kind=mpt',
      'GET /v2/accounts/{address}/mpt',
    ]) {
      expect([route, section.includes(`\n### \`${route}\`\n`)]).toEqual([route, true]);
    }
    const compatibility = partOf(markdown, '### Compatibility');
    for (const anchor of [
      '(#mpt)',
      '(#get-v2mptissuanceid)',
      '(#get-v2mptids)',
      '(#get-v2mptissuanceidholders)',
      '(#get-v2mptissuanceidtransfers)',
      '(#get-v2tokenskindmpt)',
      '(#get-v2accountsaddressmpt)',
    ]) {
      expect([anchor, compatibility.includes(anchor)]).toEqual([anchor, true]);
    }
    expect(flat(compatibility)).toContain('[ADR-0020](adr/0020-mpt-data.md)');
    expect(flat(compatibility)).toMatch(/Amendment 11, items 108 to \d+/);
  });

  it('names what the MPT data change on the routes of the original in the Compatibility list', () => {
    const compatibility = flat(partOf(markdown, '### Compatibility'));
    for (const fact of ['`mpt_issuance_id`', '`clawback`', '`<48hex>`', '`issuer does not match mpt issuance`']) {
      expect([fact, compatibility.includes(fact)]).toEqual([fact, true]);
    }
  });

  it('writes the messages of the routes as the code answers them', () => {
    const section = sectionOf(markdown);
    for (const message of [
      'invalid mpt issuance id',
      'issuance not found',
      'unable to retrieve issuance',
      'ids is required',
      'too many ids',
      'unable to retrieve issuances',
      'invalid marker',
      'unable to retrieve holders',
      'invalid start date format',
      'invalid end date format',
      `invalid kind - use: ${MPT_TRANSFER_KINDS.join(', ')}`,
      'unable to retrieve transfers',
      `invalid kind - use: ${TOKEN_KINDS.join(', ')}`,
      'invalid min_holders',
      'invalid search',
      'unable to retrieve tokens',
      'invalid ripple address',
      'unable to retrieve mpt holdings',
    ]) {
      expect([message, section.includes(`\`${message}\``)]).toEqual([message, true]);
    }
    expect(flat(partOf(markdown, '## Conventions'))).toContain('`issuer does not match mpt issuance`');
  });

  it('names the coverage feature in the Coverage section, with its parser version, its amendment and the networks without it', () => {
    const coverage = flat(partOf(markdown, '### Coverage'));
    expect(coverage).toContain('[MPT issuances](#mpt)');
    expect(coverage).toContain('`MPTokensV1`');
    expect(coverage).toContain('99,226,369');
    expect(coverage).toContain(`the MPT data with version ${COVERAGE_FEATURES.mpt.parserVersion}`);
    expect(coverage).toMatch(/the MPT issuances of Xahau and Xahau Testnet/);
    expect(COVERAGE_FEATURES.mpt.parserVersion).toBe(10);
  });

  describe('its examples', () => {
    const examples = (): Json[] => examplesOf(sectionOf(markdown));

    it('are answers of the routes with their keys in the order of the code', () => {
      expect(examplesProblemsOf(examples(), BODIES, KEYS_UNDER)).toEqual([]);
    });

    it('include an answer of every route, and each is marked for the suite that checks its values', () => {
      const all = examples();
      const bodies = all.map((example) => bodyOrderOf(example, BODIES));
      for (const body of BODIES) expect(bodies).toContain(body);
      expect(all).toHaveLength(BODIES.length);
      const markers = [...sectionOf(markdown).matchAll(/^<!-- mpt-example GET (\S+) -->\n+```json$/gm)];
      expect(markers).toHaveLength(all.length);
    });

    it('show real IDs and integer strings, as ruling C25 answers them, and no amount in an object', () => {
      const text = JSON.stringify(examples());
      expect(text).not.toContain('…');
      for (const key of ['outstanding_amount', 'escrowed_amount', 'locked_amount', 'maximum_amount', 'amount']) {
        expect([key, new RegExp(`"${key}":"\\d{1,19}"`).test(text)]).toEqual([key, true]);
      }
      expect(text).not.toMatch(/"amount":\{/);
      expect(text).toMatch(/"mpt_issuance_id":"[0-9A-F]{48}"/);
      expect(text).toMatch(/\{"mpt_issuance_id":"[0-9A-F]{48}"\}/);
      expect(text).toContain('"complete":true');
    });

    it('finds an example whose keys swapped places, and one that no answer has the keys of', () => {
      const holders = examples().find((example) => bodyOrderOf(example, BODIES) === MPT_HOLDERS_BODY_KEYS) as {
        coverage: Json;
        holders: Json;
      };
      expect(holders).toBeDefined();
      const swapped = { coverage: holders.coverage, result: 'success', holders: holders.holders };
      expect(examplesProblemsOf([swapped], BODIES, KEYS_UNDER)).toEqual([
        expect.stringMatching(/^example 1: coverage, result, holders is not in the order/),
      ]);
      expect(examplesProblemsOf([{ result: 'success', rows: [], extra: 1 }], BODIES, KEYS_UNDER)).toEqual([
        'example 1: no answer of the routes has the keys result, rows, extra',
      ]);
    });

    it('finds the keys of an issuance, of its flags and of a holder in another order than the code writes them', () => {
      const answer = examples().find((example) => bodyOrderOf(example, BODIES) === MPT_ISSUANCE_BODY_KEYS) as {
        issuance: Record<string, Json>;
      } & Record<string, Json>;
      expect(answer).toBeDefined();
      const { mpt_issuance_id, issuer, ...rest } = answer.issuance;
      const reordered = { ...answer, issuance: { issuer, mpt_issuance_id, ...rest } };
      expect(examplesProblemsOf([reordered], BODIES, KEYS_UNDER)).toEqual([
        expect.stringMatching(/^example 1\.issuance: issuer, mpt_issuance_id, .* is not in the order/),
      ]);
      const { locked, can_lock, ...flags } = answer.issuance.flags as Record<string, Json>;
      const swappedFlags = { ...answer, issuance: { ...answer.issuance, flags: { can_lock, locked, ...flags } } };
      expect(examplesProblemsOf([swappedFlags], BODIES, KEYS_UNDER)).toEqual([
        expect.stringMatching(/^example 1\.issuance\.flags: can_lock, locked, .* is not in the order/),
      ]);
      const holder = { amount: '1', holder: 'rA', escrowed_amount: '0', locked: false, authorized: true };
      const page = { result: 'success', coverage: { complete: true }, count: 1, holders: [holder] };
      expect(examplesProblemsOf([page], BODIES, KEYS_UNDER)).toEqual([
        expect.stringMatching(/^example 1\.holders\[0\]: amount, holder, .* is not in the order/),
      ]);
    });
  });

  describe('the check itself', () => {
    const lineOf = (object: string): string => lineIn(markdown, object);

    it('finds a line whose keys swapped places', () => {
      const line = lineOf('a holder');
      const swapped = line.replace('`holder, amount,', '`amount, holder,');
      expect(swapped).not.toBe(line);
      expect(problemsOf(markdown.replace(line, swapped))).toEqual([expect.stringMatching(/^drifted: a holder /)]);
    });

    it('finds a line with a key added, and one with a key gone', () => {
      const line = lineOf('a transfer');
      expect(problemsOf(markdown.replace(line, line.replace(/`\.$/, ', extra`.')))).toEqual([
        expect.stringMatching(/^drifted: a transfer /),
      ]);
      expect(problemsOf(markdown.replace(line, line.replace(/, fee\?`\.$/, '`.')))).toEqual([
        expect.stringMatching(/^drifted: a transfer /),
      ]);
    });

    it('finds a line that is missing, and one that is written twice', () => {
      const line = lineOf('an MPT row');
      expect(problemsOf(markdown.replace(`${line}\n`, ''))).toEqual(['missing: no line for an MPT row']);
      expect(problemsOf(markdown.replace(line, `${line}\n\n${line}`))).toEqual(['twice: 2 lines for an MPT row']);
    });

    it('finds a line for an object nothing owns, and a line renamed', () => {
      const line = lineOf('the MPT totals');
      expect(problemsOf(markdown.replace(line, line.replace('Keys of the MPT totals,', 'Keys of the sums,')))).toEqual([
        'missing: no line for the MPT totals',
        expect.stringMatching(/^unknown: a line for "the sums"/),
      ]);
    });

    it('reads an optional key written `key?` as the key', () => {
      const line = lineOf('an issuance');
      expect(problemsOf(markdown.replace(line, line.replace('`mpt_issuance_id,', '`mpt_issuance_id?,')))).toEqual([]);
    });

    it('does not read a line of another section', () => {
      expect(() => keyLines(markdown.replace('\n## MPT\n', '\n## Other\n'))).toThrow('has no "## MPT" heading');
      const outside = markdown.replace(
        '\n## Validations\n',
        '\n## Validations\n\nKeys of a ghost, in order: `a, b`.\n',
      );
      expect(outside).not.toBe(markdown);
      expect(problemsOf(outside)).toEqual([]);
    });
  });
});
