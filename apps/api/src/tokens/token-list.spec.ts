import { RippleHttpError } from '../common/errors';
import { Coverage } from '../common/feature-coverage.service';
import { encodeMarker } from '../common/pagination';
import {
  decodeTokenListMarker,
  encodeTokenListMarker,
  parseTokenListQuery,
  TOKEN_KINDS,
  TOKEN_LIST_KEYS,
  tokenListBody,
  TokenListPage,
} from './token-list';

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const USD = 'USD';

/** Runs `fn` and returns the message of the 400 it must throw. */
function badRequestMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RippleHttpError);
    expect((e as RippleHttpError).getStatus()).toBe(400);
    return ((e as RippleHttpError).getResponse() as { message: string }).message;
  }
  throw new Error('expected the call to throw');
}

describe('TOKEN_KINDS', () => {
  it('is issued alone until D9 adds mpt', () => {
    expect([...TOKEN_KINDS]).toEqual(['issued']);
  });
});

describe('parseTokenListQuery', () => {
  it('defaults: issued, no minimum, no search, 200 rows, JSON', () => {
    expect(parseTokenListQuery({})).toEqual({ kind: 'issued', minHolders: 0, limit: 200, csv: false });
    expect(Object.keys(parseTokenListQuery({}))).not.toContain('q');
    expect(Object.keys(parseTokenListQuery({}))).not.toContain('marker');
  });

  it('reads every parameter', () => {
    expect(
      parseTokenListQuery({
        kind: 'issued',
        min_holders: '10',
        q: ' Dollar ',
        limit: '50',
        marker: 'abc',
        format: 'CSV',
      }),
    ).toEqual({ kind: 'issued', minHolders: 10, q: 'Dollar', limit: 50, marker: 'abc', csv: true });
  });

  it('the first value of a repeated parameter wins and an empty one is the default', () => {
    expect(parseTokenListQuery({ kind: ['issued', 'mpt'], min_holders: '', q: '', marker: '' })).toEqual({
      kind: 'issued',
      minHolders: 0,
      limit: 200,
      csv: false,
    });
  });

  it('kind other than issued is 400 `invalid kind - use: issued`', () => {
    expect(badRequestMessage(() => parseTokenListQuery({ kind: 'mpt' }))).toBe('invalid kind - use: issued');
    expect(badRequestMessage(() => parseTokenListQuery({ kind: 'ISSUED' }))).toBe('invalid kind - use: issued');
  });

  it.each(['-1', '1e3', '1000000001', '1.5', ' 5', 'x', '0x10', '+3'])(
    'min_holders=%j is 400 `invalid min_holders`',
    (v) => {
      expect(badRequestMessage(() => parseTokenListQuery({ min_holders: v }))).toBe('invalid min_holders');
    },
  );

  it.each([
    ['0', 0],
    ['007', 7],
    ['1000000000', 1_000_000_000],
  ])('min_holders=%j is %d', (v, n) => {
    expect(parseTokenListQuery({ min_holders: v }).minHolders).toBe(n);
  });

  it('q is trimmed, 1 to 64 characters; blank (`q=%20` arrives as a space) is none, 65 is 400 `invalid search`', () => {
    expect(parseTokenListQuery({ q: ' ' }).q).toBeUndefined();
    expect(parseTokenListQuery({ q: '  \t ' }).q).toBeUndefined();
    expect(parseTokenListQuery({ q: ` ${'a'.repeat(64)} ` }).q).toBe('a'.repeat(64));
    expect(badRequestMessage(() => parseTokenListQuery({ q: 'a'.repeat(65) }))).toBe('invalid search');
    expect(badRequestMessage(() => parseTokenListQuery({ q: ` ${'a'.repeat(65)} ` }))).toBe('invalid search');
  });

  it('limit is 200 by default and at most 1000', () => {
    expect(parseTokenListQuery({ limit: '1000' }).limit).toBe(1000);
    expect(parseTokenListQuery({ limit: '5000' }).limit).toBe(1000);
    expect(parseTokenListQuery({ limit: 'many' }).limit).toBe(200);
  });

  it('checks kind, then min_holders, then the search', () => {
    expect(badRequestMessage(() => parseTokenListQuery({ kind: 'x', min_holders: '-1', q: 'a'.repeat(65) }))).toBe(
      'invalid kind - use: issued',
    );
    expect(badRequestMessage(() => parseTokenListQuery({ min_holders: '-1', q: 'a'.repeat(65) }))).toBe(
      'invalid min_holders',
    );
    expect(badRequestMessage(() => parseTokenListQuery({ q: 'a'.repeat(65) }))).toBe('invalid search');
  });
});

describe('the marker of the list', () => {
  it('codes (holders, issuer, key) and decodes it for its kind', () => {
    const marker = encodeTokenListMarker('issued', 48920, ISSUER, USD);
    expect(decodeTokenListMarker(marker, 'issued')).toEqual([48920, ISSUER, USD]);
  });

  it('is the base64url JSON of the kind and the three values', () => {
    const marker = encodeTokenListMarker('issued', 3, ISSUER, USD);
    expect(JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'))).toEqual(['issued', 3, ISSUER, USD]);
  });

  it('holds a token with no holders at the end of the list', () => {
    expect(decodeTokenListMarker(encodeTokenListMarker('issued', 0, ISSUER, USD), 'issued')).toEqual([0, ISSUER, USD]);
  });

  it('no marker is the first page', () => {
    expect(decodeTokenListMarker(undefined, 'issued')).toBeUndefined();
    expect(decodeTokenListMarker('', 'issued')).toBeUndefined();
  });

  it('the same values under another kind name are 400 `invalid marker`', () => {
    const other = encodeMarker(['mpt', 48920, ISSUER, USD]);
    expect(badRequestMessage(() => decodeTokenListMarker(other, 'issued'))).toBe('invalid marker');
  });

  it.each<[string, string]>([
    ['not base64', '!!'],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['not an array', Buffer.from('{}').toString('base64url')],
    ['an old marker with no kind', encodeMarker([48920, ISSUER, USD])],
    ['a negative count of holders', encodeMarker(['issued', -1, ISSUER, USD])],
    ['a fraction of holders', encodeMarker(['issued', 1.5, ISSUER, USD])],
    ['holders as text', encodeMarker(['issued', '5', ISSUER, USD])],
    ['a number for the issuer', encodeMarker(['issued', 5, 7, USD])],
    ['a null key', encodeMarker(['issued', 5, ISSUER, null])],
    ['a fifth value', encodeMarker(['issued', 5, ISSUER, USD, 'x'])],
  ])('%s is 400 `invalid marker`', (_name, marker) => {
    expect(badRequestMessage(() => decodeTokenListMarker(marker, 'issued'))).toBe('invalid marker');
  });
});

describe('tokenListBody', () => {
  const coverage: Coverage = { from_ledger_index: 99_640_001, complete: false };
  const row = { rank: 1, currency: USD, issuer: ISSUER };
  const page: TokenListPage<typeof row, { tokens: number }> = {
    ledgerIndex: 107_721_455,
    closeTime: Date.parse('2026-10-24T14:03:01Z') / 1000,
    totals: { tokens: 49_490 },
    total: 1284,
    totalBelow: 48_206,
    rows: [row],
    marker: 'next',
  };

  it('is the envelope of the spec, in the order of TOKEN_LIST_KEYS', () => {
    const body = tokenListBody('issued', coverage, page);
    expect(Object.keys(body)).toEqual([...TOKEN_LIST_KEYS]);
    expect(body).toEqual({
      result: 'success',
      coverage,
      kind: 'issued',
      ledger_index: 107_721_455,
      close_time: '2026-10-24T14:03:01Z',
      totals: { tokens: 49_490 },
      total: 1284,
      total_below: 48_206,
      count: 1,
      marker: 'next',
      tokens: [row],
    });
  });

  it('leaves out total_below when it is undefined and the marker on the last page', () => {
    const body = tokenListBody('issued', coverage, { ...page, totalBelow: undefined, marker: undefined });
    expect(Object.keys(body)).toEqual([
      'result',
      'coverage',
      'kind',
      'ledger_index',
      'close_time',
      'totals',
      'total',
      'count',
      'tokens',
    ]);
  });

  it('keeps a total_below of 0, which is a count', () => {
    expect(tokenListBody('issued', coverage, { ...page, totalBelow: 0 }).total_below).toBe(0);
  });

  it('counts the rows of the page', () => {
    expect(tokenListBody('issued', coverage, { ...page, rows: [row, row, row] }).count).toBe(3);
    expect(tokenListBody('issued', coverage, { ...page, rows: [] }).count).toBe(0);
  });

  it('is the no-generation answer for undefined: result, coverage, kind, count 0 and no tokens', () => {
    const body = tokenListBody('issued', coverage, undefined);
    expect(Object.keys(body)).toEqual(['result', 'coverage', 'kind', 'count', 'tokens']);
    expect(body).toEqual({ result: 'success', coverage, kind: 'issued', count: 0, tokens: [] });
  });

  it('the keys are the constant of the spec', () => {
    expect([...TOKEN_LIST_KEYS]).toEqual([
      'result',
      'coverage',
      'kind',
      'ledger_index',
      'close_time',
      'totals',
      'total',
      'total_below',
      'count',
      'marker',
      'tokens',
    ]);
  });
});
