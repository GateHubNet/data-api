import type { ApiClient, Harness } from '../harness';
import { cells, lines } from './amm';
import { csvDisposition } from './csv';

/**
 * The tests every list of the NFT routes passes (the shared list tests of the plan): the answer is `{result, coverage, count,
 * marker?, <key>}`, an empty list is a 200 with no marker, markers concatenate to the whole list in either direction, unknown
 * parameters are ignored and `limit` is read like the other lists', the CSV has the same columns on every page and no
 * `coverage`, the `Link` header follows the marker, the answers are `private, max-age=60`, and a request with no key is a 401.
 */

/** A list of a route under test. */
export interface ListUnderTest {
  name: string;
  /** A path that lists the rows of `want` (and no parameter that changes them), at least three rows. */
  path: string;
  /** The key of the rows in the body. */
  key: string;
  /** The rows the path lists, in the order of the list. */
  want: unknown[];
  /** A path of the same route that lists none. */
  empty: string;
  /** The columns of the CSV, in order. */
  csvColumns: string[];
  /** The name of the CSV file, without `.csv`. */
  file: string;
  /** Whether `descending=true` lists the same rows in the opposite order. */
  descending: boolean;
}

/** `path` with the parameter added: after a `?`, or starting one. */
export const withParam = (path: string, param: string): string => `${path}${path.includes('?') ? '&' : '?'}${param}`;

/** Asserts that walking `path` with each limit gives `want` in whole, every page but the last full and the last with no marker. */
export async function expectWalk(
  api: ApiClient,
  path: string,
  key: string,
  want: unknown[],
  limits = [1, 2, 3, 7],
): Promise<void> {
  for (const limit of limits) {
    const walked = await api.pages<{ count: number; marker?: string } & Record<string, unknown[]>>(path, limit, key);
    expect([path, limit, walked.flatMap((p) => p[key])]).toEqual([path, limit, want]);
    walked.forEach((page, i) => {
      expect(page.count).toBe(page[key].length);
      if (i < walked.length - 1) expect(page[key]).toHaveLength(limit);
      else expect(page.marker).toBeUndefined();
    });
  }
}

/** Runs the shared list tests of one list. `coverage` is what the feature states for the data of the suite. */
export async function expectListContract(
  h: Harness,
  api: ApiClient,
  list: ListUnderTest,
  coverage: { from_ledger_index?: number; complete: boolean },
): Promise<void> {
  const { get } = api;
  const { name } = list;

  // the answer: coverage right after result, the rows, count; nothing else
  const res = await get(withParam(list.path, 'limit=1000'));
  expect([name, res.status]).toEqual([name, 200]);
  expect([name, res.body[list.key]]).toEqual([name, list.want]);
  expect(res.body.count).toBe(list.want.length);
  expect(Object.keys(res.body)).toEqual(['result', 'coverage', 'count', list.key]);
  expect(res.body.result).toBe('success');
  expect(res.body.coverage).toEqual(coverage);
  expect(Object.keys(res.body.coverage)).toEqual(['from_ledger_index', 'complete']);

  // empty: a list with no row is a 200 with count 0, no marker, and the coverage; its CSV is an empty file
  const empty = await get(list.empty);
  expect([name, empty.status, empty.body.count, empty.body[list.key]]).toEqual([name, 200, 0, []]);
  expect(empty.body).not.toHaveProperty('marker');
  expect(Object.keys(empty.body)).toEqual(['result', 'coverage', 'count', list.key]);
  expect(empty.body.coverage).toEqual(coverage);
  const emptyCsv = await get(withParam(list.empty, 'format=csv'));
  expect([name, emptyCsv.status, emptyCsv.text]).toEqual([name, 200, '']);

  // markers concatenate, both ways
  const limits = list.want.length > 3 ? [1, 2, 3] : [1, 2];
  await expectWalk(api, list.path, list.key, list.want, limits);
  if (list.descending) {
    const reversed = [...list.want].reverse();
    expect([name, (await get(withParam(list.path, 'descending=true&limit=1000'))).body[list.key]]).toEqual([
      name,
      reversed,
    ]);
    await expectWalk(api, withParam(list.path, 'descending=true'), list.key, reversed, limits);
  } else {
    // a list with no direction: descending is a parameter it does not know
    expect([name, (await get(withParam(list.path, 'descending=true&limit=1000'))).body[list.key]]).toEqual([
      name,
      list.want,
    ]);
  }

  // unknown parameters are ignored, and limits are read like the other lists': 200 by default, a decimal cut, below one default
  const noisy = await get(withParam(list.path, 'nothing=1&interval=day&type=sell&limit=1000'));
  expect([name, noisy.body[list.key]]).toEqual([name, list.want]);
  for (const [limit, count] of [
    ['', list.want.length],
    ['0', list.want.length],
    ['abc', list.want.length],
    ['1.9', 1],
    ['5000', list.want.length],
  ] as const) {
    const limited = await get(withParam(list.path, `limit=${limit}`));
    expect([name, limit, limited.status, limited.body.count]).toEqual([name, limit, 200, count]);
  }

  // the Link header follows the marker, for JSON and CSV, and is not there on the last page
  const page = await get(withParam(list.path, 'limit=1'));
  const origin = new URL(page.request.url).origin;
  const marker = page.body.marker as string;
  expect([name, typeof marker]).toEqual([name, 'string']);
  expect(page.headers.link).toBe(`<${origin}${withParam(list.path, 'limit=1')}&marker=${marker}>; rel="next"`);
  const csvPage = await get(withParam(list.path, 'limit=1&format=csv'));
  expect(csvPage.headers.link).toBe(
    `<${origin}${withParam(list.path, 'limit=1&format=csv')}&marker=${marker}>; rel="next"`,
  );
  expect((await get(withParam(list.path, 'limit=1000'))).headers.link).toBeUndefined();
  expect((await get(withParam(list.path, 'limit=1000&format=csv'))).headers.link).toBeUndefined();

  // format=csv: text/csv named for the list, one row each, the same columns on every page, no coverage
  const csv = await get(withParam(list.path, 'format=csv&limit=1000'));
  expect([name, csv.status]).toEqual([name, 200]);
  expect(csv.headers['content-type']).toMatch(/^text\/csv/);
  expect(csv.headers['content-disposition']).toBe(csvDisposition(list.file));
  const table = lines(csv.text).map(cells);
  expect([name, table.length]).toEqual([name, 1 + list.want.length]);
  const header = list.csvColumns.map((c) => `"${c}"`);
  expect([name, table[0]]).toEqual([name, header]);
  for (const row of table) expect(row).toHaveLength(header.length);
  expect(csv.text).not.toContain('coverage');
  expect(csv.text).not.toContain('from_ledger_index');
  let next: string | undefined;
  let pages = 0;
  do {
    const more = next ? `&marker=${next}` : '';
    const part = await get(withParam(list.path, `format=csv&limit=2${more}`));
    expect([name, pages, lines(part.text)[0].split(',')]).toEqual([name, pages, header]);
    next = ((await get(withParam(list.path, `limit=2${more}`))).body as { marker?: string }).marker;
    pages += 1;
  } while (next && pages < 40);
  expect(pages).toBe(Math.ceil(list.want.length / 2));

  // an answer is private and kept 60 s, an error is not kept, and a request with no key is a 401
  const ok = await get(list.path);
  expect([name, ok.status, ok.headers['cache-control']]).toEqual([name, 200, 'private, max-age=60']);
  const bad = await get(withParam(list.path, 'marker=!!!'));
  expect([name, bad.status, bad.headers['cache-control'], bad.body]).toEqual([
    name,
    400,
    'no-store',
    { result: 'error', message: 'invalid marker' },
  ]);
  const unauthorized = await h.http().get(list.path);
  expect([name, unauthorized.status]).toEqual([name, 401]);
}
