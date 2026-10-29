import { join } from 'node:path';

/**
 * What the specs that tie a section of `docs/api-reference.md` to the code share (the validators, the NFTs, the account names and
 * tomls). The section names the keys of every object it documents, in order, on a line of the form
 *
 *   Keys of <object>, in order: `a, b?, c`.
 *
 * (a key that may be missing from an answer can be written `b?`); each spec holds the map from an object, as the line names it,
 * to the `*_KEYS` constant the code serves it by. The line is the reference, the constant is the code, and neither may drift
 * from the other: when a spec fails, fix the reference. A constant is pinned by the specs and the e2e suites of its route and is
 * never changed to fit a line.
 *
 * The examples (the fenced `json` blocks of a section) are checked as well: every object of one has its keys in the order of
 * the constant that serves it.
 */

/** `docs/api-reference.md`, from `apps/api/test/support`. */
export const REFERENCE = join(__dirname, '..', '..', '..', '..', 'docs', 'api-reference.md');

/**
 * Whether `key` is an own key of `object`: `in` would take a key of the prototype (`constructor`, `toString`) for one of the
 * map. (`Object.hasOwn` is ES2022, past the ES2021 library of the repo's TypeScript.)
 */
export const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/**
 * The text of the reference from the line `heading` (`## NFTs`, ``### `GET /v2/network/nft_volume` ``) to the next heading of
 * the same or a higher level. A line of a fenced block that starts with `#` (a shell comment) is no heading.
 */
export function partOf(markdown: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`docs/api-reference.md has no "${heading}" heading`);
  const isHeading = new RegExp(`^#{1,${level}} `);
  let fenced = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('```')) fenced = !fenced;
    else if (!fenced && isHeading.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

export interface KeysLine {
  object: string;
  /** The keys as written, with the `?` of an optional one stripped. */
  keys: string[];
}

/**
 * The checks of one section of the reference against the objects it documents (`objects`: the object as its line names it, to
 * the constant that holds its keys; one entry for each constant of the routes).
 */
export function referenceChecks(heading: string, objects: Record<string, readonly string[]>) {
  /** The section of the reference, from its heading to the next of its level. */
  const sectionOf = (markdown: string): string => partOf(markdown, heading);

  /** Every `Keys of <object>, in order: ...` line of the section, in the order they stand. */
  const keyLines = (markdown: string): KeysLine[] =>
    [...sectionOf(markdown).matchAll(/^Keys of (.+?), in order: (.+)$/gm)].map(([, object, list]) => ({
      object,
      keys: list
        .replace(/`/g, '')
        .replace(/\.\s*$/, '')
        .split(',')
        .map((key) => key.trim().replace(/\?$/, '')),
    }));

  /** What is wrong with the lines of a reference, as sentences: a line that drifted, one that is missing, one nothing owns, one written twice. */
  const problemsOf = (markdown: string): string[] => {
    const lines = keyLines(markdown);
    const problems: string[] = [];
    for (const [object, constant] of Object.entries(objects)) {
      const own = lines.filter((line) => line.object === object);
      if (own.length === 0) problems.push(`missing: no line for ${object}`);
      else if (own.length > 1) problems.push(`twice: ${own.length} lines for ${object}`);
      else if (JSON.stringify(own[0].keys) !== JSON.stringify(constant)) {
        problems.push(
          `drifted: ${object} is written ${own[0].keys.join(', ')}; the code serves ${constant.join(', ')}`,
        );
      }
    }
    for (const { object } of lines) {
      if (!hasOwn(objects, object)) problems.push(`unknown: a line for "${object}", which the map does not name`);
    }
    return problems;
  };

  /** The line of `object`, whole, as the section writes it. */
  const lineOf = (markdown: string, object: string): string => {
    for (const [line] of sectionOf(markdown).matchAll(/^Keys of .+?, in order: .+$/gm)) {
      if (line.startsWith(`Keys of ${object}, in order:`)) return line;
    }
    throw new Error(`no line for ${object}`);
  };

  return { sectionOf, keyLines, problemsOf, lineOf };
}

// -- the examples ----------------------------------------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The fenced `json` blocks of a text, parsed. A block that is not JSON is an error (the examples are answers, whole). */
export function examplesOf(text: string): Json[] {
  return [...text.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map(([, body]) => JSON.parse(body) as Json);
}

/** Whether `keys` come in the order of `order` (each one is there, and no key stands before one that must come first). */
export function inOrder(keys: string[], order: readonly string[]): boolean {
  const places = keys.map((key) => order.indexOf(key));
  return places.every((place, i) => place >= 0 && (i === 0 || place > places[i - 1]));
}

/**
 * What is wrong with the keys of an example: an object whose keys are not in the order of its constant, or one it has no key of.
 * `under` names the constant the object under a key is served by; a list takes the key of its elements.
 */
export function exampleProblems(
  value: Json,
  order: readonly string[],
  where: string,
  under: Record<string, readonly string[]>,
): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => exampleProblems(item, order, `${where}[${i}]`, under));
  if (value === null || typeof value !== 'object') return [];
  const keys = Object.keys(value);
  const problems = inOrder(keys, order) ? [] : [`${where}: ${keys.join(', ')} is not in the order ${order.join(', ')}`];
  for (const [key, inner] of Object.entries(value)) {
    if (hasOwn(under, key)) problems.push(...exampleProblems(inner, under[key], `${where}.${key}`, under));
  }
  return problems;
}

/** The answer an example is, told by the list or object it ends with and by every key being one of the answer's. */
export function bodyOrderOf(example: Json, bodies: readonly (readonly string[])[]): readonly string[] | undefined {
  if (example === null || typeof example !== 'object' || Array.isArray(example)) return undefined;
  const keys = Object.keys(example);
  return bodies.find(
    (body) => keys.every((key) => body.includes(key)) && keys[keys.length - 1] === body[body.length - 1],
  );
}

/** Every problem of the examples: one that no answer has the keys of, and the keys of the rest in the order of their constants. */
export function examplesProblemsOf(
  examples: Json[],
  bodies: readonly (readonly string[])[],
  under: Record<string, readonly string[]>,
): string[] {
  return examples.flatMap((example, i) => {
    const order = bodyOrderOf(example, bodies);
    if (order === undefined) {
      return [`example ${i + 1}: no answer of the routes has the keys ${Object.keys(example as object).join(', ')}`];
    }
    return exampleProblems(example, order, `example ${i + 1}`, under);
  });
}
