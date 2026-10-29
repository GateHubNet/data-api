import { readFileSync } from 'node:fs';
import {
  bodyOrderOf,
  exampleProblems,
  examplesOf,
  examplesProblemsOf,
  hasOwn,
  Json,
  partOf,
  REFERENCE,
  referenceChecks,
} from '../../test/support/api-reference-check';
import * as accountNamesObject from './account-names-object';
import {
  ACCOUNT_NAME_ENTRY_KEYS,
  ACCOUNT_NAMES_BODY_KEYS,
  DISPLAY_NAME_KEYS,
  LABEL_KEYS,
} from './account-names-object';
import { MAX_ADDRESSES } from './account-names.controller';
import * as tomlObject from './toml-object';
import { TOML_ACCOUNT_KEYS, TOML_CURRENCY_KEYS, TOML_KEYS, TOML_VALIDATOR_KEYS } from './toml-object';

/*
 * The "Account names and tomls" section of docs/api-reference.md names the keys of every object it documents, in order, on a
 * line of the form
 *
 *   Keys of <object>, in order: `a, b?, c`.
 *
 * (a key that may be missing from an answer can be written `b?`). This spec ties each of those lines to the constant the code
 * serves the object by: the line is the reference, the constant is the code, and neither may drift from the other. When one
 * fails, fix the reference; a constant is pinned by the specs and the e2e suites of its route, and is never changed to fit a
 * line. The examples of the section are the answers of the end-to-end suites (`display-names.e2e-spec.ts`, `toml.e2e-spec.ts`):
 * their keys come in the order of the constants, which the second half of the spec checks, so that an example cannot be edited
 * out of the code's order either. The checks themselves are in `test/support/api-reference-check.ts`.
 */

const HEADING = '## Account names and tomls';

/** The object as the reference names it on its line, and the constant that holds its keys. One entry for each constant of the routes. */
const OBJECTS: Record<string, readonly string[]> = {
  // GET /v2/account_names
  'the answer': ACCOUNT_NAMES_BODY_KEYS,
  'an entry': ACCOUNT_NAME_ENTRY_KEYS,
  display_name: DISPLAY_NAME_KEYS,
  'a label': LABEL_KEYS,
  // GET /v2/toml/{domain}
  toml: TOML_KEYS,
  'a toml account': TOML_ACCOUNT_KEYS,
  'a toml currency': TOML_CURRENCY_KEYS,
  'a toml validator': TOML_VALIDATOR_KEYS,
};

const { sectionOf, keyLines, problemsOf, lineOf: lineIn } = referenceChecks(HEADING, OBJECTS);

// -- the examples ----------------------------------------------------------------------------------------------------------

/** The keys of the answer of `GET /v2/toml/{domain}`, which has no constant of its own: `result`, then the `toml`. */
const TOML_BODY_KEYS = ['result', 'toml'] as const;

/** The labels of an entry come in the order of the `Enum8` of `account_labels` (`scam`, `spam`, `advisory`). */
const LABELS_ORDER = ['scam', 'spam', 'advisory'] as const;

/** The constant the object under a key is served by; a list takes the key of its elements. */
const KEYS_UNDER: Record<string, readonly string[]> = {
  account_names: ACCOUNT_NAME_ENTRY_KEYS,
  display_name: DISPLAY_NAME_KEYS,
  labels: LABELS_ORDER,
  scam: LABEL_KEYS,
  spam: LABEL_KEYS,
  advisory: LABEL_KEYS,
  toml: TOML_KEYS,
  accounts: TOML_ACCOUNT_KEYS,
  currencies: TOML_CURRENCY_KEYS,
  validators: TOML_VALIDATOR_KEYS,
};

/** The answers of the two routes: each ends with the list or the object that tells it from the other. */
const BODIES: readonly (readonly string[])[] = [ACCOUNT_NAMES_BODY_KEYS, TOML_BODY_KEYS];

describe('the "Account names and tomls" section of docs/api-reference.md', () => {
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

  it('is checked against every *_KEYS constant of the two objects modules: none is left out of the map', () => {
    const exported = [accountNamesObject, tomlObject].flatMap((module) =>
      Object.entries(module).filter(([name]) => name.endsWith('_KEYS')),
    );
    expect(exported.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'ACCOUNT_NAMES_BODY_KEYS',
        'ACCOUNT_NAME_ENTRY_KEYS',
        'DISPLAY_NAME_KEYS',
        'LABEL_KEYS',
        'TOML_KEYS',
        'TOML_ACCOUNT_KEYS',
        'TOML_CURRENCY_KEYS',
        'TOML_VALIDATOR_KEYS',
      ]),
    );
    const mapped = new Set<unknown>(Object.values(OBJECTS));
    expect(exported.filter(([, value]) => !mapped.has(value)).map(([name]) => name)).toEqual([]);
    // and no constant stands for two objects
    expect(mapped.size).toBe(Object.keys(OBJECTS).length);
  });

  it('has no problem', () => {
    expect(problemsOf(markdown)).toEqual([]);
  });

  it('documents both routes, each under a heading of its own', () => {
    const section = sectionOf(markdown);
    expect(section).toContain('\n### `GET /v2/account_names`\n');
    expect(section).toContain('\n### `GET /v2/toml/{domain}`\n');
  });

  it('writes the messages of both routes as the code answers them, and the limit of the batch', () => {
    const section = sectionOf(markdown);
    for (const message of [
      'addresses is required',
      `too many addresses - at most ${MAX_ADDRESSES}`,
      'invalid ripple address',
      'unable to retrieve account names',
      'invalid domain',
      'toml not found',
      'unable to retrieve toml',
    ]) {
      expect([message, section.includes(`\`${message}\``)]).toEqual([message, true]);
    }
  });

  describe('its examples', () => {
    const examples = (): Json[] => examplesOf(sectionOf(markdown));

    it('are answers of the two routes with their keys in the order of the code', () => {
      expect(examplesProblemsOf(examples(), BODIES, KEYS_UNDER)).toEqual([]);
    });

    it('include an answer of every kind of display name, a label of each kind, a toml that was read and ones that failed', () => {
      const all = examples();
      const bodies = all.map((example) => bodyOrderOf(example, BODIES));
      for (const body of BODIES) expect(bodies).toContain(body);
      const text = JSON.stringify(all);
      for (const kind of ['verified', 'account', 'domain']) expect(text).toContain(`"kind":"${kind}"`);
      expect(text).toContain('"labels":{');
      expect(text).toContain('"status":"ok"');
      expect(text).toContain('"status":"failed"');
      // an entry nothing names is only its address
      const entries = all.flatMap(
        (example) => (example as { account_names?: Record<string, Json>[] }).account_names ?? [],
      );
      expect(entries.some((entry) => Object.keys(entry).join() === 'address')).toBe(true);
    });

    it('finds an example whose keys swapped places, and one that no answer has the keys of', () => {
      const first = examples().find((example) => bodyOrderOf(example, BODIES) === ACCOUNT_NAMES_BODY_KEYS) as {
        count: Json;
        account_names: Json;
      };
      expect(first).toBeDefined();
      const swapped = { result: 'success', account_names: first.account_names, count: first.count };
      expect(exampleProblems(swapped, ACCOUNT_NAMES_BODY_KEYS, 'x', KEYS_UNDER)).toEqual([
        expect.stringMatching(/^x: result, account_names, count is not in the order/),
      ]);
      const entry = { domain: 'a.example', address: 'rA', display_name: { kind: 'domain', text: 'a.example' } };
      expect(
        exampleProblems(
          { result: 'success', count: 1, account_names: [entry] },
          ACCOUNT_NAMES_BODY_KEYS,
          'x',
          KEYS_UNDER,
        ),
      ).toEqual([
        expect.stringMatching(/^x\.account_names\[0\]: domain, address, display_name is not in the order/),
        expect.stringMatching(/^x\.account_names\[0\]\.display_name: kind, text is not in the order/),
      ]);
      expect(bodyOrderOf({ result: 'success', rows: [], extra: 1 }, BODIES)).toBeUndefined();
    });

    it('finds the labels of an entry in another order than scam, spam, advisory', () => {
      const labels = { advisory: { description: 'd' }, scam: { description: 'd' } };
      const entry = { address: 'rA', labels };
      expect(
        exampleProblems(
          { result: 'success', count: 1, account_names: [entry] },
          ACCOUNT_NAMES_BODY_KEYS,
          'x',
          KEYS_UNDER,
        ),
      ).toEqual([expect.stringMatching(/^x\.account_names\[0\]\.labels: advisory, scam is not in the order/)]);
    });
  });

  describe('the check itself', () => {
    const lineOf = (object: string): string => lineIn(markdown, object);

    it('finds a line whose keys swapped places', () => {
      const line = lineOf('display_name');
      const swapped = line.replace('`text, kind`', '`kind, text`');
      expect(swapped).not.toBe(line);
      expect(problemsOf(markdown.replace(line, swapped))).toEqual([expect.stringMatching(/^drifted: display_name /)]);
    });

    it('finds a line with a key added, and one with a key gone', () => {
      const line = lineOf('a toml validator');
      expect(problemsOf(markdown.replace(line, line.replace(/\.$/, ', extra.')))).toEqual([
        expect.stringMatching(/^drifted: a toml validator /),
      ]);
      expect(problemsOf(markdown.replace(line, line.replace(/, unl\??`\.$/, '`.')))).toEqual([
        expect.stringMatching(/^drifted: a toml validator /),
      ]);
    });

    it('finds a line that is missing, and one that is written twice', () => {
      const line = lineOf('a toml currency');
      expect(problemsOf(markdown.replace(`${line}\n`, ''))).toEqual(['missing: no line for a toml currency']);
      expect(problemsOf(markdown.replace(line, `${line}\n\n${line}`))).toEqual(['twice: 2 lines for a toml currency']);
    });

    it('finds a line for an object nothing owns, and a line renamed', () => {
      const line = lineOf('a label');
      expect(problemsOf(markdown.replace(line, line.replace('Keys of a label,', 'Keys of the label,')))).toEqual([
        'missing: no line for a label',
        expect.stringMatching(/^unknown: a line for "the label"/),
      ]);
    });

    it('reads an optional key written `key?` as the key', () => {
      const line = lineOf('a toml account');
      expect(problemsOf(markdown.replace(line, line.replace('`address,', '`address?,')))).toEqual([]);
    });

    it('does not read a line of another section', () => {
      expect(() => keyLines(markdown.replace('\n## Account names and tomls\n', '\n## Other\n'))).toThrow(
        'has no "## Account names and tomls" heading',
      );
      const outside = markdown.replace('\n## Stats\n', '\n## Stats\n\nKeys of a ghost, in order: `a, b`.\n');
      expect(outside).not.toBe(markdown);
      expect(problemsOf(outside)).toEqual([]);
    });

    it('ends a section at a heading, and not at a line of a fenced block that starts with #', () => {
      const text =
        '## One\n\n```bash\n# a comment\n## another\n```\n\nafter the block\n\n### Under\n\n## Two\n\nnot in One\n';
      expect(partOf(text, '## One')).toBe(
        '## One\n\n```bash\n# a comment\n## another\n```\n\nafter the block\n\n### Under\n',
      );
    });
  });
});
