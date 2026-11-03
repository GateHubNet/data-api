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
import * as supplyObject from './supply-object';
import {
  AMM_KEYS,
  BURNED_KEYS,
  CIRCULATING_KEYS,
  ESCROWED_KEYS,
  MINTED_BODY_KEYS,
  MINTED_KEYS,
  MINTED_ROW_KEYS,
  RESERVES_KEYS,
  SUPPLY_KEYS,
} from './supply-object';

/*
 * The two supply routes of the "Network" section of docs/api-reference.md name the keys of every object they document, in order, on a
 * line of the form
 *
 *   Keys of <object>, in order: `a, b?, c`.
 *
 * (a key that may be missing from an answer can be written `b?`). This spec ties each of those lines to the constant the code serves
 * the object by: the line is the reference, the constant is the code, and neither may drift from the other. When one fails, fix the
 * reference; a constant is pinned by the specs and the e2e suites of its route (`supply.e2e-spec.ts`, `supply-minted.e2e-spec.ts`), and
 * is never changed to fit a line. The examples are answers of those suites: their keys come in the order of the constants. The checks
 * themselves are in `test/support/api-reference-check.ts`.
 *
 * The check is scoped to the two headings: the rest of the Network section has no key lines. The headings themselves are read by the
 * e2e suites, which take the examples from under them.
 */

const SUPPLY_HEADING = '### `GET /v2/network/supply`';
const MINTED_HEADING = '### `GET /v2/network/supply/minted`';

/** The object as the reference names it on its line, and the constant that holds its keys. */
const SUPPLY_OBJECTS: Record<string, readonly string[]> = {
  'the supply answer': SUPPLY_KEYS,
  burned: BURNED_KEYS,
  minted: MINTED_KEYS,
  escrowed: ESCROWED_KEYS,
  circulating: CIRCULATING_KEYS,
  amm: AMM_KEYS,
  reserves: RESERVES_KEYS,
};
const MINTED_OBJECTS: Record<string, readonly string[]> = {
  'the minted answer': MINTED_BODY_KEYS,
  'a minted day': MINTED_ROW_KEYS,
};

const supply = referenceChecks(SUPPLY_HEADING, SUPPLY_OBJECTS);
const minted = referenceChecks(MINTED_HEADING, MINTED_OBJECTS);

/** The constant the object under a key is served by; a list takes the key of its elements. */
const KEYS_UNDER: Record<string, readonly string[]> = {
  coverage: COVERAGE_KEYS,
  burned: BURNED_KEYS,
  minted: MINTED_KEYS,
  escrowed: ESCROWED_KEYS,
  circulating: CIRCULATING_KEYS,
  amm: AMM_KEYS,
  reserves: RESERVES_KEYS,
  rows: MINTED_ROW_KEYS,
};

const BODIES: readonly (readonly string[])[] = [SUPPLY_KEYS, MINTED_BODY_KEYS];

describe('the supply routes of docs/api-reference.md', () => {
  const markdown = readFileSync(REFERENCE, 'utf8');
  const flat = (text: string): string => text.replace(/\s+/g, ' ');

  it('has no problem in the lines of either route', () => {
    expect(supply.problemsOf(markdown)).toEqual([]);
    expect(minted.problemsOf(markdown)).toEqual([]);
  });

  it('is checked against every *_KEYS constant of the object module: none is left out of the maps', () => {
    const exported = Object.entries(supplyObject).filter(([name]) => name.endsWith('_KEYS'));
    expect(exported.map(([name]) => name).sort()).toEqual(
      [
        'AMM_KEYS',
        'BURNED_KEYS',
        'CIRCULATING_KEYS',
        'ESCROWED_KEYS',
        'MINTED_BODY_KEYS',
        'MINTED_KEYS',
        'MINTED_ROW_KEYS',
        'RESERVES_KEYS',
        'SUPPLY_KEYS',
      ].sort(),
    );
    const mapped = new Set<unknown>([...Object.values(SUPPLY_OBJECTS), ...Object.values(MINTED_OBJECTS)]);
    expect(exported.filter(([, value]) => !mapped.has(value)).map(([name]) => name)).toEqual([]);
    // and no constant stands for two objects
    expect(mapped.size).toBe(Object.keys(SUPPLY_OBJECTS).length + Object.keys(MINTED_OBJECTS).length);
  });

  it('closes every code block of both routes on a line of its own', () => {
    expect(fenceProblems(supply.sectionOf(markdown))).toEqual([]);
    expect(fenceProblems(minted.sectionOf(markdown))).toEqual([]);
  });

  it('links both routes from the Compatibility list of extras, as the items of ADR-0010 they are', () => {
    const compatibility = partOf(markdown, '### Compatibility');
    for (const anchor of ['(#get-v2networksupply)', '(#get-v2networksupplyminted)']) {
      expect([anchor, compatibility.includes(anchor)]).toEqual([anchor, true]);
    }
    expect(flat(compatibility)).toContain('Amendment 9, items 103 to 104');
  });

  it('writes the messages of the routes as the code answers them', () => {
    for (const message of ['supply not computed yet', 'unable to retrieve supply']) {
      expect([message, supply.sectionOf(markdown).includes(`\`${message}\``)]).toEqual([message, true]);
    }
    for (const message of [
      'invalid start date format',
      'invalid end date format',
      'invalid interval',
      'invalid marker',
      'unable to retrieve minted supply',
    ]) {
      expect([message, minted.sectionOf(markdown).includes(`\`${message}\``)]).toEqual([message, true]);
    }
  });

  it('names the five coverage features with the parser versions they are registered with', () => {
    const table = supply.sectionOf(markdown);
    for (const feature of ['fees', 'mints', 'escrows', 'amm', 'account_states'] as const) {
      const row = `\`${feature}\` | ${COVERAGE_FEATURES[feature].parserVersion} |`;
      expect([feature, table.includes(row)]).toEqual([feature, true]);
    }
    expect(flat(minted.sectionOf(markdown))).toContain(
      `the feature \`mints\` (parser version ${COVERAGE_FEATURES.mints.parserVersion};`,
    );
  });

  it('lists the features and the mint parser in the Coverage section', () => {
    const coverage = flat(partOf(markdown, '### Coverage'));
    for (const feature of ['fees', 'mints', 'amm', 'account_states']) {
      expect([feature, coverage.includes(`\`${feature}\``)]).toEqual([feature, true]);
    }
    expect(coverage).toContain(`version ${COVERAGE_FEATURES.mints.parserVersion}`);
  });

  describe('its examples', () => {
    const supplyExamples = (): Json[] => examplesOf(supply.sectionOf(markdown));
    const mintedExamples = (): Json[] => examplesOf(minted.sectionOf(markdown));

    it('are answers of the routes with their keys in the order of the code', () => {
      expect(examplesProblemsOf(supplyExamples(), BODIES, KEYS_UNDER)).toEqual([]);
      expect(examplesProblemsOf(mintedExamples(), BODIES, KEYS_UNDER)).toEqual([]);
    });

    it('show the XRP Ledger without minted and Xahau without amm, and a page of days with a marker', () => {
      const answers = supplyExamples().filter((example) => bodyOrderOf(example, BODIES) === SUPPLY_KEYS) as Record<
        string,
        Json
      >[];
      expect(answers.some((answer) => hasOwn(answer, 'amm') && !hasOwn(answer, 'minted'))).toBe(true);
      expect(answers.some((answer) => hasOwn(answer, 'minted') && !hasOwn(answer, 'amm'))).toBe(true);
      const pages = mintedExamples().filter((example) => bodyOrderOf(example, BODIES) === MINTED_BODY_KEYS);
      expect(pages.some((page) => hasOwn(page as object, 'marker'))).toBe(true);
    });

    it('finds an example whose keys swapped places', () => {
      const answer = supplyExamples().find((example) => bodyOrderOf(example, BODIES) === SUPPLY_KEYS) as Record<
        string,
        Json
      >;
      const { result, ledger_index, ...rest } = answer;
      const swapped = { ledger_index, result, ...rest };
      expect(examplesProblemsOf([swapped], BODIES, KEYS_UNDER)).toEqual([
        expect.stringMatching(/^example 1: ledger_index, result, .* is not in the order/),
      ]);
    });
  });

  describe('the check itself', () => {
    it('finds a line whose keys swapped places, and one that is missing', () => {
      const line = supply.lineOf(markdown, 'reserves');
      const swapped = line.replace('`amount, accounts,', '`accounts, amount,');
      expect(swapped).not.toBe(line);
      expect(supply.problemsOf(markdown.replace(line, swapped))).toEqual([
        expect.stringMatching(/^drifted: reserves /),
      ]);
      expect(supply.problemsOf(markdown.replace(`${line}\n`, ''))).toEqual(['missing: no line for reserves']);
    });

    it('reads the lines of one route only: the two headings do not run into each other', () => {
      expect(supply.keyLines(markdown).map((line) => line.object)).toEqual(Object.keys(SUPPLY_OBJECTS));
      expect(minted.keyLines(markdown).map((line) => line.object)).toEqual(Object.keys(MINTED_OBJECTS));
    });
  });
});
