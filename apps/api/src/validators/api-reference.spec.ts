import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as amendmentObject from './amendment-object';
import {
  AMENDMENT_DETAIL_KEYS,
  AMENDMENT_ROW_KEYS,
  AMENDMENT_VOTES_KEYS,
  AMENDMENTS_BODY_KEYS,
  ENABLED_KEYS,
  HISTORY_KEYS,
  MAJORITY_KEYS,
  ROUND_KEYS,
  ROUND_POINT_KEYS,
  UNL_VOTE_KEYS,
} from './amendment-object';
import * as summaryObject from './summary-object';
import { PUBLISHER_KEYS, SUMMARY_KEYS } from './summary-object';
import * as validationRowObject from './validation-row-object';
import { VALIDATION_ROW_KEYS, VALIDATIONS_BODY_KEYS } from './validation-row-object';
import * as validatorObject from './validator-object';
import {
  AGREEMENT_KEYS,
  DAILY_KEYS,
  DETAIL_AMENDMENT_VOTES_KEYS,
  DETAIL_TAIL_KEYS,
  DOMAIN_VERIFICATION_KEYS,
  FEE_VOTE_KEYS,
  LIST_BODY_KEYS,
  MANIFEST_KEYS,
  ROW_AMENDMENT_VOTES_KEYS,
  VALIDATOR_ROW_KEYS,
  VOTE_ENTRY_KEYS,
  YES_ENTRY_KEYS,
} from './validator-object';

/*
 * The "Validators and amendments" section of docs/api-reference.md names the keys of every object it documents, in order, on
 * a line of the form
 *
 *   Keys of <object>, in order: `a, b, c`.
 *
 * (a key that may be missing from an answer can be written `b?`). This spec ties each of those lines to the constant the
 * code serves the object by: the line is the reference, the constant is the code, and neither may drift from the other. When
 * one fails, fix the reference; a constant is pinned by the specs and the e2e suites of its route, and is never changed to
 * fit a line.
 */

const REFERENCE = join(__dirname, '..', '..', '..', '..', 'docs', 'api-reference.md');
const SECTION = 'Validators and amendments';

/**
 * Whether `key` is an own key of `object`: `in` would take a key of the prototype (`constructor`, `toString`) for one of the
 * map. (`Object.hasOwn` is ES2022, past the ES2021 library of the repo's TypeScript.)
 */
const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** The object as the reference names it on its line, and the constant that holds its keys. One entry for each constant of the routes. */
const OBJECTS: Record<string, readonly string[]> = {
  // GET /v2/network/validators/summary
  'the summary': SUMMARY_KEYS,
  'a publisher': PUBLISHER_KEYS,
  // GET /v2/network/validators and GET /v2/network/validators/{key}
  'the validators answer': LIST_BODY_KEYS,
  'a validator row': VALIDATOR_ROW_KEYS,
  'an agreement window': AGREEMENT_KEYS,
  domain_verification: DOMAIN_VERIFICATION_KEYS,
  fee_vote: FEE_VOTE_KEYS,
  'amendment_votes on a row of the list': ROW_AMENDMENT_VOTES_KEYS,
  'a yes entry': YES_ENTRY_KEYS,
  'amendment_votes on the validator answer': DETAIL_AMENDMENT_VOTES_KEYS,
  'a vote entry': VOTE_ENTRY_KEYS,
  'the validator answer after the row': DETAIL_TAIL_KEYS,
  manifest: MANIFEST_KEYS,
  'a daily agreement': DAILY_KEYS,
  // GET /v2/network/validators/{key}/validations
  'the validations answer': VALIDATIONS_BODY_KEYS,
  'a validation': VALIDATION_ROW_KEYS,
  // GET /v2/network/amendments and GET /v2/network/amendments/{name}
  'the amendments answer': AMENDMENTS_BODY_KEYS,
  'the newest round': ROUND_KEYS,
  'an amendment row': AMENDMENT_ROW_KEYS,
  votes: AMENDMENT_VOTES_KEYS,
  majority: MAJORITY_KEYS,
  enabled: ENABLED_KEYS,
  'the amendment answer': AMENDMENT_DETAIL_KEYS,
  'a UNL vote': UNL_VOTE_KEYS,
  'a round': ROUND_POINT_KEYS,
  'a history event': HISTORY_KEYS,
};

/** The section of the reference, from its `##` heading to the next one. */
function sectionOf(markdown: string): string {
  const heading = `\n## ${SECTION}\n`;
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`docs/api-reference.md has no "${SECTION}" section`);
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end < 0 ? rest : rest.slice(0, end);
}

interface KeysLine {
  object: string;
  /** The keys as written, with the `?` of an optional one stripped. */
  keys: string[];
}

/** Every `Keys of <object>, in order: ...` line of the section, in the order they stand. */
function keyLines(markdown: string): KeysLine[] {
  return [...sectionOf(markdown).matchAll(/^Keys of (.+?), in order: (.+)$/gm)].map(([, object, list]) => ({
    object,
    keys: list
      .replace(/`/g, '')
      .replace(/\.\s*$/, '')
      .split(',')
      .map((key) => key.trim().replace(/\?$/, '')),
  }));
}

/** What is wrong with the lines of a reference, as sentences: a line that drifted, one that is missing, one nothing owns, one written twice. */
function problemsOf(markdown: string): string[] {
  const lines = keyLines(markdown);
  const problems: string[] = [];
  for (const [object, constant] of Object.entries(OBJECTS)) {
    const own = lines.filter((line) => line.object === object);
    if (own.length === 0) problems.push(`missing: no line for ${object}`);
    else if (own.length > 1) problems.push(`twice: ${own.length} lines for ${object}`);
    else if (JSON.stringify(own[0].keys) !== JSON.stringify(constant)) {
      problems.push(`drifted: ${object} is written ${own[0].keys.join(', ')}; the code serves ${constant.join(', ')}`);
    }
  }
  for (const { object } of lines) {
    if (!hasOwn(OBJECTS, object)) problems.push(`unknown: a line for "${object}", which the map does not name`);
  }
  return problems;
}

describe('the "Validators and amendments" section of docs/api-reference.md', () => {
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

  it('is checked against every *_KEYS constant of the four objects modules: none is left out of the map', () => {
    const exported = [summaryObject, validatorObject, amendmentObject, validationRowObject].flatMap((module) =>
      Object.entries(module).filter(([name]) => name.endsWith('_KEYS')),
    );
    expect(exported.length).toBeGreaterThanOrEqual(26);
    const mapped = new Set<unknown>(Object.values(OBJECTS));
    expect(exported.filter(([, value]) => !mapped.has(value)).map(([name]) => name)).toEqual([]);
    // and no constant stands for two objects
    expect(mapped.size).toBe(Object.keys(OBJECTS).length);
  });

  it('has no problem', () => {
    expect(problemsOf(markdown)).toEqual([]);
  });

  describe('the check itself', () => {
    const lineOf = (object: string): string => {
      const found = /^Keys of .+?, in order: .+$/gm;
      for (const [line] of sectionOf(markdown).matchAll(found)) {
        if (line.startsWith(`Keys of ${object}, in order:`)) return line;
      }
      throw new Error(`no line for ${object}`);
    };

    it('finds a line whose keys swapped places', () => {
      const line = lineOf('a publisher');
      const swapped = line.replace('`id, url,', '`url, id,');
      expect(swapped).not.toBe(line);
      expect(problemsOf(markdown.replace(line, swapped))).toEqual([expect.stringMatching(/^drifted: a publisher /)]);
    });

    it('finds a line with a key added, and one with a key gone', () => {
      const line = lineOf('a validation');
      expect(problemsOf(markdown.replace(line, line.replace(/\.$/, ', extra.')))).toEqual([
        expect.stringMatching(/^drifted: a validation /),
      ]);
      expect(problemsOf(markdown.replace(line, line.replace(', count`.', '`.')))).toEqual([
        expect.stringMatching(/^drifted: a validation /),
      ]);
    });

    it('finds a line that is missing, and one that is written twice', () => {
      const line = lineOf('a history event');
      expect(problemsOf(markdown.replace(`${line}\n`, ''))).toEqual(['missing: no line for a history event']);
      expect(problemsOf(markdown.replace(line, `${line}\n\n${line}`))).toEqual(['twice: 2 lines for a history event']);
    });

    it('finds a line for an object nothing owns, and a line renamed', () => {
      const line = lineOf('majority');
      expect(problemsOf(markdown.replace(line, line.replace('Keys of majority,', 'Keys of the majority,')))).toEqual([
        'missing: no line for majority',
        expect.stringMatching(/^unknown: a line for "the majority"/),
      ]);
    });

    it('reads an optional key written `key?` as the key', () => {
      const line = lineOf('a publisher');
      expect(problemsOf(markdown.replace(line, line.replace('`sequence,', '`sequence?,')))).toEqual([]);
    });

    it('does not read a line of another section', () => {
      expect(() => keyLines(markdown.replace('\n## Validators and amendments\n', '\n## Other\n'))).toThrow(
        'has no "Validators and amendments" section',
      );
      const outside = markdown.replace('\n## Stats\n', '\n## Stats\n\nKeys of a ghost, in order: `a, b`.\n');
      expect(outside).not.toBe(markdown);
      expect(problemsOf(outside)).toEqual([]);
    });
  });
});
