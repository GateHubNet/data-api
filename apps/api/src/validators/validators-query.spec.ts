import { deepFreeze } from '../../../../packages/shared/src/test-utils/deep-freeze';
import { decodeMarker, encodeMarker } from '../common/pagination';
import { compareEntries, Directory, DirectoryEntry, PublisherState } from './directory';
import { comparePlaces, listValidators, MARKER_KEYS, parseListQuery, placeOf } from './validators-query';

const ID_A = 'AB'.repeat(32);
const NAMES: Record<string, string> = { TestVoting: ID_A, testvoting: ID_A };
const amendmentId = (ref: string): string | undefined => NAMES[ref];

/** An entry with what the list reads of it; everything else is left out (the list never reads it). */
function entry(key: string, over: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    key,
    unl: false,
    unlLists: [],
    seen24h: false,
    listed: true,
    ...over,
  } as DirectoryEntry;
}

const publisher = (id: string): PublisherState =>
  ({ id, url: `https://${id}`, publicKey: 'ED', status: 'ok' }) as PublisherState;

/** The directory of the list: the entries in list order, and the publishers. */
function directoryOf(entries: DirectoryEntry[], publishers: string[] = ['vl.ripple.com', 'unl.xrplf.org']) {
  return deepFreeze({
    ordered: entries,
    publishers: publishers.map(publisher),
  }) as Pick<Directory, 'ordered' | 'publishers'>;
}

const keysOf = (rows: readonly DirectoryEntry[]): string[] => rows.map((row) => row.key);

function expectBad(fn: () => unknown, message: string): void {
  expect(fn).toThrow(expect.objectContaining({ status: 400 }));
  try {
    fn();
  } catch (err) {
    expect((err as { getResponse(): unknown }).getResponse()).toEqual({ result: 'error', message });
  }
}

const parse = (query: Record<string, unknown>, dir = directoryOf([])) => parseListQuery(query, dir, amendmentId);

describe('parseListQuery', () => {
  it('defaults to the UNL, no filter, no marker and 200 rows', () => {
    expect(parse({})).toEqual({ scope: 'unl', limit: 200 });
  });

  it('ignores parameters it does not know, and takes the first of a repeated one', () => {
    expect(parse({ sort: 'desc', foo: 'bar' })).toEqual({ scope: 'unl', limit: 200 });
    expect(parse({ scope: ['all', 'unl'] })).toMatchObject({ scope: 'all' });
  });

  it('takes an empty parameter as missing', () => {
    expect(parse({ scope: '', publisher: '', amendment: '', q: '', marker: '', limit: '' })).toEqual({
      scope: 'unl',
      limit: 200,
    });
  });

  describe('scope', () => {
    it('is unl or all', () => {
      expect(parse({ scope: 'unl' }).scope).toBe('unl');
      expect(parse({ scope: 'all' }).scope).toBe('all');
    });

    it.each(['x', 'ALL', 'Unl', 'all,unl', ' all'])('answers 400 invalid scope for %j', (scope) => {
      expectBad(() => parse({ scope }), 'invalid scope');
    });
  });

  describe('publisher', () => {
    it('is the id of a publisher of the directory', () => {
      expect(parse({ publisher: 'unl.xrplf.org' }).publisher).toBe('unl.xrplf.org');
    });

    it.each(['nope', 'VL.RIPPLE.COM', 'https://vl.ripple.com'])('answers 400 invalid publisher for %j', (value) => {
      expectBad(() => parse({ publisher: value }), 'invalid publisher');
    });

    it('answers 400 for any publisher when the directory has none', () => {
      expectBad(() => parse({ publisher: 'vl.ripple.com' }, directoryOf([], [])), 'invalid publisher');
    });
  });

  describe('amendment', () => {
    it('is a name the amendments know, resolved to its ID', () => {
      expect(parse({ amendment: 'TestVoting' }).amendment).toBe(ID_A);
      expect(parse({ amendment: 'testvoting' }).amendment).toBe(ID_A);
    });

    it('is 64 hex digits, in either case, made upper-case, known or not', () => {
      expect(parse({ amendment: ID_A.toLowerCase() }).amendment).toBe(ID_A);
      expect(parse({ amendment: '0f'.repeat(32) }).amendment).toBe('0F'.repeat(32));
    });

    it.each(['NoSuchName', 'AB'.repeat(31), 'AB'.repeat(33), 'zz'.repeat(32)])(
      'answers 400 invalid amendment for %j',
      (value) => {
        expectBad(() => parse({ amendment: value }), 'invalid amendment');
      },
    );
  });

  describe('q', () => {
    it('is lower-cased, and 100 characters are allowed', () => {
      expect(parse({ q: 'NorthPeak' }).q).toBe('northpeak');
      expect(parse({ q: 'a'.repeat(100) }).q).toBe('a'.repeat(100));
    });

    it('answers 400 invalid search for 101 characters', () => {
      expectBad(() => parse({ q: 'a'.repeat(101) }), 'invalid search');
    });

    it('counts characters, not UTF-16 units', () => {
      expect(parse({ q: '\u{1F600}'.repeat(100) }).q).toBe('\u{1F600}'.repeat(100));
      expectBad(() => parse({ q: '\u{1F600}'.repeat(101) }), 'invalid search');
    });

    it.each(['(', '[', '.*', '%', '\\', '^$', '?'])('takes %j as it is: text, not a pattern', (q) => {
      expect(parse({ q }).q).toBe(q);
    });
  });

  describe('marker', () => {
    it('is the group, the sort text and the master key of a row', () => {
      expect(parse({ marker: encodeMarker([0, 'northpeak.example', 'nH1']) }).marker).toEqual([
        0,
        'northpeak.example',
        'nH1',
      ]);
      expect(parse({ marker: encodeMarker([1, '', 'nH2']) }).marker).toEqual([1, '', 'nH2']);
    });

    it.each([
      ['%%%', '%%%'],
      ['not json', Buffer.from('not json').toString('base64url')],
      ['an object', Buffer.from('{}').toString('base64url')],
      ['two values', encodeMarker([0, 'a'])],
      ['four values', encodeMarker([0, 'a', 'b', 'c'])],
      ['a text group', encodeMarker(['0', 'a', 'b'])],
      ['a group of 2', encodeMarker([2, 'a', 'b'])],
      ['a group of -1', Buffer.from('[-1,"a","b"]').toString('base64url')],
      ['a number for the sort text', Buffer.from('[0,5,"b"]').toString('base64url')],
      ['a number for the key', Buffer.from('[0,"a",5]').toString('base64url')],
      ['a sort text in the group without a domain', encodeMarker([1, 'a', 'b'])],
    ])('answers 400 invalid marker for %s', (_name, marker) => {
      expectBad(() => parse({ marker }), 'invalid marker');
    });

    it('is checked against the keys of the list', () => {
      expect(MARKER_KEYS).toEqual([
        { column: 'group', type: 'UInt16' },
        { column: 'sort', type: 'String' },
        { column: 'key', type: 'String' },
      ]);
      expect(decodeMarker(encodeMarker([0, 'a', 'b']), MARKER_KEYS)).toEqual([0, 'a', 'b']);
    });
  });

  describe('limit', () => {
    it('is 200 by default and at most 1000', () => {
      expect(parse({}).limit).toBe(200);
      expect(parse({ limit: '25' }).limit).toBe(25);
      expect(parse({ limit: '1000' }).limit).toBe(1000);
      expect(parse({ limit: '5000' }).limit).toBe(1000);
    });

    it('falls back to the default for a limit below one or not a number', () => {
      expect(parse({ limit: '0' }).limit).toBe(200);
      expect(parse({ limit: '-3' }).limit).toBe(200);
      expect(parse({ limit: 'many' }).limit).toBe(200);
    });
  });

  it('checks in the order scope, publisher, amendment, q, marker, limit', () => {
    const everything = { scope: 'x', publisher: 'x', amendment: 'x', q: 'a'.repeat(101), marker: '%%%' };
    expectBad(() => parse(everything), 'invalid scope');
    expectBad(() => parse({ ...everything, scope: 'all' }), 'invalid publisher');
    expectBad(() => parse({ ...everything, scope: 'all', publisher: 'vl.ripple.com' }), 'invalid amendment');
    expectBad(
      () => parse({ ...everything, scope: 'all', publisher: 'vl.ripple.com', amendment: 'TestVoting' }),
      'invalid search',
    );
    expectBad(
      () => parse({ ...everything, scope: 'all', publisher: 'vl.ripple.com', amendment: 'TestVoting', q: 'a' }),
      'invalid marker',
    );
  });
});

describe('listValidators', () => {
  // in list order: with a domain first by lower-case domain, then by key; the rest by key
  const unlA = entry('nHA', { domain: 'Alpha.example', unl: true, unlLists: ['vl.ripple.com', 'unl.xrplf.org'] });
  const unlB = entry('nHB', {
    domain: 'beta.example',
    unl: true,
    unlLists: ['vl.ripple.com'],
    signingKey: 'n9BetaKey',
  });
  const unlC = entry('nHC', { unl: true, unlLists: ['unl.xrplf.org'] });
  const unlD = entry('nHD', {
    unl: true,
    unlLists: ['vl.ripple.com'],
    record: { amendments: [ID_A.toLowerCase()] } as never,
  });
  const otherE = entry('nHE', { domain: 'Zulu.example', seen24h: true });
  const otherF = entry('nHF', { seen24h: true, signingKey: 'n9FoxKey' });
  const lapsedG = entry('nHG', {});
  const ordered = [unlA, unlB, otherE, unlC, unlD, otherF, lapsedG];
  const dir = directoryOf(ordered);

  const list = (query: Record<string, unknown>) => listValidators(dir, parse(query, dir));

  it('lists the UNL by default, whether seen or not', () => {
    expect(keysOf(list({}).rows)).toEqual(['nHA', 'nHB', 'nHC', 'nHD']);
  });

  it('adds every validator seen in 24 hours with scope=all, and still not one seen only within 30 days', () => {
    expect(keysOf(list({ scope: 'all' }).rows)).toEqual(['nHA', 'nHB', 'nHE', 'nHC', 'nHD', 'nHF']);
  });

  describe('the order of a marker', () => {
    // mixed case, domains that are one once lower-cased, upper-case keys before lower-case ones, and validators without a domain
    const mixed = [
      entry('nHQ2', { domain: 'Same.example' }),
      entry('nHQ1', { domain: 'same.EXAMPLE' }),
      entry('nHQ3', { domain: 'same.example' }),
      entry('nHA9', { domain: 'alpha.example' }),
      entry('nHZ1', { domain: 'Beta.example' }),
      entry('nHB1', { domain: 'beta.example' }),
      entry('nHC1'),
      entry('nHA1'),
      entry('nHc0'),
      entry('nHD1', { domain: 'A.Example' }),
      entry('nHD0', { domain: 'a.example' }),
      entry('nHA2', { domain: 'Zulu.example' }),
    ].map((each) => ({ ...each, unl: true }));
    // the order of the directory (assembleDirectory sorts its list with compareEntries)
    const orderedMixed = [...mixed].sort(compareEntries);

    it('is the order of the directory: placeOf and comparePlaces say what compareEntries says of every pair', () => {
      for (const a of orderedMixed) {
        for (const b of orderedMixed) {
          expect([a.key, b.key, Math.sign(comparePlaces(placeOf(a), placeOf(b)))]).toEqual([
            a.key,
            b.key,
            Math.sign(compareEntries(a, b)),
          ]);
        }
      }
      expect(keysOf(orderedMixed)).toEqual([
        'nHD0',
        'nHD1',
        'nHA9',
        'nHB1',
        'nHZ1',
        'nHQ1',
        'nHQ2',
        'nHQ3',
        'nHA2',
        'nHA1',
        'nHC1',
        'nHc0',
      ]);
    });

    it('so pages of one row, marker after marker, walk the directory in its order', () => {
      const directory = directoryOf(orderedMixed);
      const walked: string[] = [];
      let marker: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = listValidators(
          directory,
          parse({ limit: '1', ...(marker === undefined ? {} : { marker }) }, directory),
        );
        walked.push(...keysOf(page.rows));
        marker = page.marker;
        if (marker === undefined) break;
      }
      expect(walked).toEqual(keysOf(orderedMixed));
    });
  });

  it('filters by publisher: the validators on its list in use', () => {
    expect(keysOf(list({ publisher: 'unl.xrplf.org' }).rows)).toEqual(['nHA', 'nHC']);
    expect(keysOf(list({ publisher: 'vl.ripple.com' }).rows)).toEqual(['nHA', 'nHB', 'nHD']);
    expect(keysOf(list({ publisher: 'vl.ripple.com', scope: 'all' }).rows)).toEqual(['nHA', 'nHB', 'nHD']);
  });

  it('filters by amendment: the validators whose record has it, in either case', () => {
    expect(keysOf(list({ amendment: ID_A, scope: 'all' }).rows)).toEqual(['nHD']);
    expect(keysOf(list({ amendment: 'TestVoting' }).rows)).toEqual(['nHD']);
    expect(list({ amendment: 'CD'.repeat(32) }).rows).toEqual([]);
  });

  it('searches the domain, the master key and the signing key, without regard to case', () => {
    expect(keysOf(list({ q: 'ALPHA' }).rows)).toEqual(['nHA']);
    expect(keysOf(list({ q: '.example', scope: 'all' }).rows)).toEqual(['nHA', 'nHB', 'nHE']);
    expect(keysOf(list({ q: 'nhc' }).rows)).toEqual(['nHC']);
    expect(keysOf(list({ q: 'betakey' }).rows)).toEqual(['nHB']);
    expect(keysOf(list({ q: 'FOXKEY', scope: 'all' }).rows)).toEqual(['nHF']);
    expect(list({ q: 'nothing' }).rows).toEqual([]);
  });

  it('searches for the text of a search, not for a pattern: regular expression and LIKE characters match themselves', () => {
    for (const q of ['(', '[', '.*', '%', '_', '\\', '^', '$', '?']) {
      expect([q, list({ q, scope: 'all' }).rows]).toEqual([q, []]);
    }
    // a dot is a dot: the validators with a domain
    expect(keysOf(list({ q: '.', scope: 'all' }).rows)).toEqual(['nHA', 'nHB', 'nHE']);
  });

  it('applies every filter together', () => {
    expect(keysOf(list({ publisher: 'vl.ripple.com', q: '.example' }).rows)).toEqual(['nHA', 'nHB']);
    expect(keysOf(list({ publisher: 'unl.xrplf.org', amendment: ID_A }).rows)).toEqual([]);
  });

  describe('paging', () => {
    const all = (limit: number) => list({ scope: 'all', limit: String(limit) });

    it('has no marker when everything fits', () => {
      expect(all(6).marker).toBeUndefined();
      expect(all(100).marker).toBeUndefined();
      expect(keysOf(all(100).rows)).toHaveLength(6);
    });

    it('has the marker of the last row of a page that is followed by more', () => {
      const page = all(2);
      expect(keysOf(page.rows)).toEqual(['nHA', 'nHB']);
      expect(decodeMarker(page.marker, MARKER_KEYS)).toEqual([0, 'beta.example', 'nHB']);
    });

    it('resumes after the row of the marker', () => {
      const second = list({ scope: 'all', limit: '2', marker: all(2).marker });
      expect(keysOf(second.rows)).toEqual(['nHE', 'nHC']);
      // the group without a domain has the empty text for sort
      expect(decodeMarker(second.marker, MARKER_KEYS)).toEqual([1, '', 'nHC']);
      const third = list({ scope: 'all', limit: '2', marker: second.marker });
      expect(keysOf(third.rows)).toEqual(['nHD', 'nHF']);
      expect(third.marker).toBeUndefined();
    });

    it.each([1, 2, 3, 4, 5])('concatenates the pages of limit=%i to the unpaged list', (limit) => {
      const unpaged = keysOf(list({ scope: 'all' }).rows);
      const walked: string[] = [];
      let marker: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = list({ scope: 'all', limit: String(limit), ...(marker === undefined ? {} : { marker }) });
        walked.push(...keysOf(page.rows));
        marker = page.marker;
        if (marker === undefined) break;
      }
      expect(walked).toEqual(unpaged);
    });

    it('resumes after a marker whose row is no longer in the list', () => {
      // a row of the domain group that is not there: the next row after its place
      const marker = encodeMarker([0, 'beta.example.gone', 'nHZ']);
      expect(keysOf(list({ scope: 'all', marker }).rows)).toEqual(['nHE', 'nHC', 'nHD', 'nHF']);
      // after the last row of the list: nothing
      expect(list({ scope: 'all', marker: encodeMarker([1, '', 'nHZZ']) }).rows).toEqual([]);
      // before the first: everything
      expect(keysOf(list({ scope: 'all', marker: encodeMarker([0, '', 'a']) }).rows)).toHaveLength(6);
    });

    it('pages the filtered list', () => {
      const first = list({ q: '.example', scope: 'all', limit: '1' });
      expect(keysOf(first.rows)).toEqual(['nHA']);
      const second = list({ q: '.example', scope: 'all', limit: '1', marker: first.marker });
      expect(keysOf(second.rows)).toEqual(['nHB']);
      const third = list({ q: '.example', scope: 'all', limit: '1', marker: second.marker });
      expect(keysOf(third.rows)).toEqual(['nHE']);
      expect(third.marker).toBeUndefined();
    });
  });

  it('never changes the directory: a frozen directory is listed, filtered, searched and paged', () => {
    // `dir` is deeply frozen: a sort, a splice or a write on the shared list or an entry would throw
    expect(() => {
      list({ scope: 'all', q: 'e', limit: '2' });
      list({ publisher: 'vl.ripple.com', amendment: ID_A });
    }).not.toThrow();
    expect(Object.isFrozen(dir.ordered)).toBe(true);
    expect(keysOf(dir.ordered)).toEqual(keysOf(ordered));
  });

  it('gives a copy: the page is not the list of the directory', () => {
    expect(list({ scope: 'all', limit: '1000' }).rows).not.toBe(dir.ordered);
  });
});
