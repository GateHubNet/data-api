import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as featureCoverage from '../common/feature-coverage.service';
import { COVERAGE_KEYS } from '../common/feature-coverage.service';
import * as volumeObject from '../network/volume-object';
import { NFT_VOLUME_BODY_KEYS, NFT_VOLUME_COMPONENT_KEYS } from '../network/volume-object';
import * as nftObjects from './nft-objects';
import {
  BURNED_AT_KEYS,
  COLLECTION_BODY_KEYS,
  COLLECTION_DAY_KEYS,
  COLLECTION_KEYS,
  COLLECTIONS_BODY_KEYS,
  HOLDER_KEYS,
  HOLDERS_BODY_KEYS,
  LAST_SALE_KEYS,
  MINTED_KEYS,
  NFT_BODY_KEYS,
  NFT_EVENT_KEYS,
  NFT_EVENTS_BODY_KEYS,
  NFT_KEYS,
  NFT_OFFER_KEYS,
  NFT_OFFERS_BODY_KEYS,
  NFT_SALE_KEYS,
  NFTS_BODY_KEYS,
  POINT_KEYS,
  SALES_BODY_KEYS,
  STATS_BODY_KEYS,
} from './nft-objects';

/*
 * The "NFTs" section of docs/api-reference.md names the keys of every object it documents, in order, on a line of the form
 *
 *   Keys of <object>, in order: `a, b?, c`.
 *
 * (a key that may be missing from an answer can be written `b?`). This spec ties each of those lines to the constant the code
 * serves the object by: the line is the reference, the constant is the code, and neither may drift from the other. When one
 * fails, fix the reference; a constant is pinned by the specs and the e2e suites of its route, and is never changed to fit a
 * line. The examples of the section are real answers of the end-to-end seeds: their keys come in the order of the constants,
 * which the second half of the spec checks, so that an example cannot be edited out of the code's order either.
 *
 * `GET /v2/network/nft_volume` is documented under Network, beside the other volumes; its two lines (the component and the
 * answer) stand in this section with the other objects, and its examples are read with it.
 */

const REFERENCE = join(__dirname, '..', '..', '..', '..', 'docs', 'api-reference.md');
const SECTION = 'NFTs';
/** The heading of the route of the NFT volume, whose examples belong to this reference too. */
const VOLUME_HEADING = '### `GET /v2/network/nft_volume`';

/**
 * Whether `key` is an own key of `object`: `in` would take a key of the prototype (`constructor`, `toString`) for one of the
 * map. (`Object.hasOwn` is ES2022, past the ES2021 library of the repo's TypeScript.)
 */
const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** The object as the reference names it on its line, and the constant that holds its keys. One entry for each constant of the routes. */
const OBJECTS: Record<string, readonly string[]> = {
  // every answer: the key after `result`
  'the coverage': COVERAGE_KEYS,
  // GET /v2/nfts/{nft_id} and the NFTs of an account or a collection
  'an NFT': NFT_KEYS,
  'a point': POINT_KEYS,
  minted: MINTED_KEYS,
  burned_at: BURNED_AT_KEYS,
  last_sale: LAST_SALE_KEYS,
  // the history of an NFT or of an account
  'an NFT event': NFT_EVENT_KEYS,
  // the sales of the network and of a collection
  'an NFT sale': NFT_SALE_KEYS,
  // GET /v2/nfts/{nft_id}/offers
  'an NFT offer': NFT_OFFER_KEYS,
  // the collections
  'a collection': COLLECTION_KEYS,
  'a collection day': COLLECTION_DAY_KEYS,
  'a holder': HOLDER_KEYS,
  // the answers
  'the NFT answer': NFT_BODY_KEYS,
  'the NFT history answer': NFT_EVENTS_BODY_KEYS,
  'the NFT offers answer': NFT_OFFERS_BODY_KEYS,
  'the collections answer': COLLECTIONS_BODY_KEYS,
  'the collection answer': COLLECTION_BODY_KEYS,
  'the collection NFTs answer': NFTS_BODY_KEYS,
  'the holders answer': HOLDERS_BODY_KEYS,
  'the sales answer': SALES_BODY_KEYS,
  'the stats answer': STATS_BODY_KEYS,
  // GET /v2/network/nft_volume
  'an NFT volume component': NFT_VOLUME_COMPONENT_KEYS,
  'the NFT volume answer': NFT_VOLUME_BODY_KEYS,
};

/** The text of the reference from `heading` to the next heading of the same or a higher level. */
function partOf(markdown: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`docs/api-reference.md has no "${heading}" heading`);
  const rest = markdown.slice(start + 1);
  const next = new RegExp(`\\n#{1,${level}} `).exec(rest.slice(heading.length));
  return next === null ? rest : rest.slice(0, heading.length + next.index);
}

/** The section of the reference, from its `##` heading to the next one. */
const sectionOf = (markdown: string): string => partOf(markdown, `## ${SECTION}`);

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

// -- the examples ----------------------------------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The fenced `json` blocks of a text, parsed. A block that is not JSON is an error (the examples are answers, whole). */
function examplesOf(text: string): Json[] {
  return [...text.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map(([, body]) => JSON.parse(body) as Json);
}

/**
 * The keys of a row of the NFT volume, as the reference writes them for the volume routes ("Row keys: ..."): the row is the one
 * of the other volumes (`VolumeRow`, which has no constant), the key of its fees estimate is not on this metric's rows.
 */
const VOLUME_ROW_KEYS = [
  'components',
  'count',
  'exchange',
  'total',
  'exchange_rate',
  'start_time',
  'end_time',
] as const;

/** The constant the object under a key is served by; a list takes the key of its elements. */
const KEYS_UNDER: Record<string, readonly string[]> = {
  coverage: COVERAGE_KEYS,
  nft: NFT_KEYS,
  nfts: NFT_KEYS,
  events: NFT_EVENT_KEYS,
  offers: NFT_OFFER_KEYS,
  sales: NFT_SALE_KEYS,
  collection: COLLECTION_KEYS,
  collections: COLLECTION_KEYS,
  holders: HOLDER_KEYS,
  days: COLLECTION_DAY_KEYS,
  owner_since: POINT_KEYS,
  first_mint: POINT_KEYS,
  last_mint: POINT_KEYS,
  minted: MINTED_KEYS,
  burned_at: BURNED_AT_KEYS,
  last_sale: LAST_SALE_KEYS,
  rows: VOLUME_ROW_KEYS,
  components: NFT_VOLUME_COMPONENT_KEYS,
};

/** Whether `keys` come in the order of `order` (each one is there, and no key stands before one that must come first). */
function inOrder(keys: string[], order: readonly string[]): boolean {
  const places = keys.map((key) => order.indexOf(key));
  return places.every((place, i) => place >= 0 && (i === 0 || place > places[i - 1]));
}

/** What is wrong with the keys of an example: an object whose keys are not in the order of its constant, or one it has no key of. */
function exampleProblems(value: Json, order: readonly string[], where: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => exampleProblems(item, order, `${where}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  const keys = Object.keys(value);
  const problems = inOrder(keys, order) ? [] : [`${where}: ${keys.join(', ')} is not in the order ${order.join(', ')}`];
  for (const [key, inner] of Object.entries(value)) {
    if (hasOwn(KEYS_UNDER, key)) problems.push(...exampleProblems(inner, KEYS_UNDER[key], `${where}.${key}`));
  }
  return problems;
}

/** The answers of the routes: each ends with the list or the object that tells it from the others. */
const BODIES: readonly (readonly string[])[] = [
  NFT_BODY_KEYS,
  NFT_EVENTS_BODY_KEYS,
  NFT_OFFERS_BODY_KEYS,
  COLLECTIONS_BODY_KEYS,
  COLLECTION_BODY_KEYS,
  NFTS_BODY_KEYS,
  HOLDERS_BODY_KEYS,
  SALES_BODY_KEYS,
  STATS_BODY_KEYS,
  NFT_VOLUME_BODY_KEYS,
];

/** The answer an example is, told by the list or object it ends with and by every key being one of the answer's. */
function bodyOrderOf(example: Json): readonly string[] | undefined {
  if (example === null || typeof example !== 'object' || Array.isArray(example)) return undefined;
  const keys = Object.keys(example);
  return BODIES.find(
    (body) => keys.every((key) => body.includes(key)) && keys[keys.length - 1] === body[body.length - 1],
  );
}

/** Every problem of the examples of the NFTs section and of the NFT volume route. */
function examplesProblemsOf(markdown: string): string[] {
  const examples = [...examplesOf(sectionOf(markdown)), ...examplesOf(partOf(markdown, VOLUME_HEADING))];
  return examples.flatMap((example, i) => {
    const order = bodyOrderOf(example);
    if (order === undefined) {
      return [
        `example ${i + 1}: no answer of the NFT routes has the keys ${Object.keys(example as object).join(', ')}`,
      ];
    }
    return exampleProblems(example, order, `example ${i + 1}`);
  });
}

describe('the "NFTs" section of docs/api-reference.md', () => {
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

  it('is checked against every *_KEYS constant of the NFT objects, the NFT volume and the coverage: none is left out of the map', () => {
    const exported = [nftObjects, volumeObject, featureCoverage].flatMap((module) =>
      Object.entries(module).filter(([name]) => name.endsWith('_KEYS')),
    );
    expect(exported.map(([name]) => name)).toEqual(
      expect.arrayContaining(['NFT_KEYS', 'COVERAGE_KEYS', 'NFT_VOLUME_COMPONENT_KEYS']),
    );
    const mapped = new Set<unknown>(Object.values(OBJECTS));
    expect(exported.filter(([, value]) => !mapped.has(value)).map(([name]) => name)).toEqual([]);
    // and no constant stands for two objects
    expect(mapped.size).toBe(Object.keys(OBJECTS).length);
  });

  it('has no problem', () => {
    expect(problemsOf(markdown)).toEqual([]);
  });

  describe('its examples', () => {
    it('are answers of the NFT routes with their keys in the order of the code', () => {
      expect(examplesProblemsOf(markdown)).toEqual([]);
    });

    it('include an answer of every kind of the routes, on both networks', () => {
      const examples = [...examplesOf(sectionOf(markdown)), ...examplesOf(partOf(markdown, VOLUME_HEADING))];
      const bodies = examples.map(bodyOrderOf);
      for (const body of BODIES) expect(bodies).toContain(body);
      const kinds = JSON.stringify(examples);
      expect(kinds).toContain('"kind":"nftoken"');
      expect(kinds).toContain('"kind":"uritoken"');
    });

    it('finds an example whose keys swapped places, and one that no answer has the keys of', () => {
      const first = examplesOf(sectionOf(markdown))[0];
      expect(first).toMatchObject({ result: 'success' });
      const swapped = {
        coverage: (first as { coverage: Json }).coverage,
        result: 'success',
        nft: (first as { nft: Json }).nft,
      };
      expect(exampleProblems(swapped, NFT_BODY_KEYS, 'x')).toEqual([
        expect.stringMatching(/^x: coverage, result, nft is not in the order/),
      ]);
      const { nft_id: id, ...rest } = (first as unknown as { nft: { nft_id: string } }).nft;
      const moved = { ...rest, nft_id: id };
      expect(exampleProblems({ result: 'success', coverage: {}, nft: moved }, NFT_BODY_KEYS, 'x')).toEqual([
        expect.stringMatching(/^x\.nft: kind, .*, nft_id is not in the order/),
      ]);
      expect(bodyOrderOf({ result: 'success', rows: [], extra: 1 })).toBeUndefined();
    });
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
      const line = lineOf('a holder');
      const swapped = line.replace('`owner, held`', '`held, owner`');
      expect(swapped).not.toBe(line);
      expect(problemsOf(markdown.replace(line, swapped))).toEqual([expect.stringMatching(/^drifted: a holder /)]);
    });

    it('finds a line with a key added, and one with a key gone', () => {
      const line = lineOf('an NFT offer');
      expect(problemsOf(markdown.replace(line, line.replace(/\.$/, ', extra.')))).toEqual([
        expect.stringMatching(/^drifted: an NFT offer /),
      ]);
      expect(problemsOf(markdown.replace(line, line.replace(', created_time`.', '`.')))).toEqual([
        expect.stringMatching(/^drifted: an NFT offer /),
      ]);
    });

    it('finds a line that is missing, and one that is written twice', () => {
      const line = lineOf('a collection day');
      expect(problemsOf(markdown.replace(`${line}\n`, ''))).toEqual(['missing: no line for a collection day']);
      expect(problemsOf(markdown.replace(line, `${line}\n\n${line}`))).toEqual(['twice: 2 lines for a collection day']);
    });

    it('finds a line for an object nothing owns, and a line renamed', () => {
      const line = lineOf('minted');
      expect(problemsOf(markdown.replace(line, line.replace('Keys of minted,', 'Keys of the mint,')))).toEqual([
        'missing: no line for minted',
        expect.stringMatching(/^unknown: a line for "the mint"/),
      ]);
    });

    it('reads an optional key written `key?` as the key', () => {
      const line = lineOf('a holder');
      expect(problemsOf(markdown.replace(line, line.replace('`owner,', '`owner?,')))).toEqual([]);
    });

    it('does not read a line of another section', () => {
      expect(() => keyLines(markdown.replace('\n## NFTs\n', '\n## Other\n'))).toThrow('has no "## NFTs" heading');
      const outside = markdown.replace('\n## Stats\n', '\n## Stats\n\nKeys of a ghost, in order: `a, b`.\n');
      expect(outside).not.toBe(markdown);
      expect(problemsOf(outside)).toEqual([]);
    });
  });
});
