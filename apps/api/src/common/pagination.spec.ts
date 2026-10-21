import { Controller, Get, INestApplication, Req, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request, Response } from 'express';
import request from 'supertest';
import { RippleHttpError } from './errors';
import {
  decodeMarker,
  encodeMarker,
  keysetClause,
  KeysetKey,
  KeyType,
  orderByClause,
  paginate,
  setLinkHeader,
} from './pagination';

const KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt16' },
];

/** A marker as a client could hand it back, whatever the values are. */
const raw = (values: unknown): string => Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');

function expectInvalidMarker(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(RippleHttpError);
  expect((thrown as RippleHttpError).getStatus()).toBe(400);
  expect((thrown as RippleHttpError).getResponse()).toEqual({ result: 'error', message: 'invalid marker' });
}

describe('encodeMarker', () => {
  it('is the base64url of the JSON array', () => {
    expect(encodeMarker([123, 'abc'])).toBe(Buffer.from('[123,"abc"]', 'utf8').toString('base64url'));
  });

  it('is safe in a URL and an HTTP header: no padding, no + or /', () => {
    const values = ['?>?>?>', 'ÿþý', 1];
    // the plain base64 of this text has a + and a /, so that the check below means something
    expect(Buffer.from(JSON.stringify(values), 'utf8').toString('base64')).toMatch(/[+/]/);
    expect(encodeMarker(values)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('decodeMarker', () => {
  it('round-trips the key values', () => {
    expect(decodeMarker(encodeMarker([4_000_000, 7]), KEYS)).toEqual([4_000_000, 7]);
    expect(decodeMarker(encodeMarker(['rAcc', 5]), [{ column: 'a', type: 'String' }, KEYS[1]])).toEqual(['rAcc', 5]);
  });

  it('also reads the padded and the plain-alphabet form of the same marker', () => {
    const json = JSON.stringify([4_000_000, 7]);
    expect(decodeMarker(Buffer.from(json).toString('base64'), KEYS)).toEqual([4_000_000, 7]);
    expect(decodeMarker(Buffer.from(JSON.stringify([1, 2])).toString('base64'), KEYS)).toEqual([1, 2]);
  });

  it('is undefined without a marker: the first page', () => {
    expect(decodeMarker(undefined, KEYS)).toBeUndefined();
    expect(decodeMarker('', KEYS)).toBeUndefined();
  });

  it.each([
    ['text that is not base64url', '@@@'],
    ['base64url of text that is not JSON', Buffer.from('not json').toString('base64url')],
    ['a space (a + that lost its escape)', 'WzEs MF0'],
    ['padding in the middle', 'Wz=Es'],
    ['a JSON object', raw({ ledger_index: 1, tx_index: 2 })],
    ['a JSON number', raw(5)],
    ['a JSON string', raw('[1,2]')],
    ['JSON null', raw(null)],
    ['too few values', raw([1])],
    ['too many values', raw([1, 2, 3])],
    ['an empty array', raw([])],
    ['a string in a UInt32 slot', raw(['1', 2])],
    ['null in a UInt32 slot', raw([null, 2])],
    ['a nested array', raw([[1], 2])],
  ])('answers 400 invalid marker for %s', (_what, marker) => {
    expectInvalidMarker(() => decodeMarker(marker, KEYS));
  });

  describe('by key type', () => {
    const decode = (type: KeyType, value: unknown) => decodeMarker(raw([value]), [{ column: 'k', type }]);
    const ok = (type: KeyType, value: unknown) => expect(decode(type, value)).toEqual([value]);
    const bad = (type: KeyType, value: unknown) => expectInvalidMarker(() => decode(type, value));

    it.each([
      ['UInt32', 0],
      ['UInt32', 4_294_967_295],
      ['UInt16', 0],
      ['UInt16', 65_535],
      ['UInt64', 0],
      ['UInt64', Number.MAX_SAFE_INTEGER],
      ['Int16', -32_768],
      ['Int16', 0],
      ['Int16', 32_767],
      ['DateTime', 0],
      ['DateTime', 1_421_256_550],
      ['String', ''],
      ['String', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
      ['Float64', 0],
      ['Float64', -2.25],
      ['Float64', 28_110_514.1946255],
      ['Float64', 1e21],
      ['Float64', 5e-324],
    ] as [KeyType, string | number][])('%s accepts %j', (type, value) => ok(type, value));

    it.each([
      ['UInt32', -1],
      ['UInt32', 1.5],
      ['UInt32', 4_294_967_296],
      ['UInt32', '1'],
      ['UInt32', true],
      ['UInt16', 65_536],
      ['UInt16', -1],
      ['UInt64', -1],
      ['UInt64', 0.5],
      ['UInt64', 2 ** 53],
      ['UInt64', '12'],
      ['Int16', -32_769],
      ['Int16', 32_768],
      ['Int16', 1.5],
      ['Int16', '1'],
      ['DateTime', 1.5],
      ['DateTime', -1],
      ['DateTime', 4_294_967_296],
      ['DateTime', '2015-01-14 17:29:10'],
      ['String', 1],
      ['String', null],
      ['String', ['a']],
      ['Float64', '1.5'],
      ['Float64', true],
      ['Float64', null],
      ['Float64', [1]],
    ] as [KeyType, unknown][])('%s rejects %j', (type, value) => bad(type, value));

    it('Float64 rejects what is not finite (JSON.parse reads 1e999 as Infinity)', () => {
      expectInvalidMarker(() =>
        decodeMarker(Buffer.from('[1e999]').toString('base64url'), [{ column: 'k', type: 'Float64' }]),
      );
      expectInvalidMarker(() =>
        decodeMarker(Buffer.from('[-1e999]').toString('base64url'), [{ column: 'k', type: 'Float64' }]),
      );
    });
  });

  describe('a nullable key', () => {
    // a list sorted by a nullable column (NULLS LAST) has a pool without a value as the last row of a page
    const KEYS_WITH_NULL: KeysetKey[] = [
      { column: 'value', type: 'Float64', nullable: true },
      { column: 'account', type: 'String' },
    ];

    it('takes null for its column and a value of its type, and nothing else', () => {
      expect(decodeMarker(raw([null, 'rA']), KEYS_WITH_NULL)).toEqual([null, 'rA']);
      expect(decodeMarker(raw([1.5, 'rA']), KEYS_WITH_NULL)).toEqual([1.5, 'rA']);
      expectInvalidMarker(() => decodeMarker(raw(['x', 'rA']), KEYS_WITH_NULL));
      expectInvalidMarker(() => decodeMarker(raw([true, 'rA']), KEYS_WITH_NULL));
      expectInvalidMarker(() => decodeMarker(raw([1, 'rA', 3]), KEYS_WITH_NULL));
      expectInvalidMarker(() => decodeMarker(raw([1]), KEYS_WITH_NULL));
    });

    it('does not take null for a column that is not nullable', () => {
      expectInvalidMarker(() => decodeMarker(raw([1.5, null]), KEYS_WITH_NULL));
      expectInvalidMarker(() => decodeMarker(raw([null, 2]), KEYS));
    });

    it('is encoded as JSON null', () => {
      expect(encodeMarker([null, 'rA'])).toBe(raw([null, 'rA']));
    });
  });
});

describe('keysetClause', () => {
  it('has no clause on the first page', () => {
    expect(keysetClause(KEYS, false)).toEqual({ clause: '', params: {} });
    expect(keysetClause(KEYS, true, undefined, 'm')).toEqual({ clause: '', params: {} });
  });

  it('compares the key tuple, with bound params, after the marker in ascending order', () => {
    expect(keysetClause(KEYS, false, [4_000_000, 7])).toEqual({
      clause: 'ledger_index >= {k0:UInt32} AND (ledger_index, tx_index) > ({k0:UInt32}, {k1:UInt16})',
      params: { k0: 4_000_000, k1: 7 },
    });
  });

  it('bounds the first column on its own as well: ClickHouse cannot read a tuple comparison on the primary key', () => {
    // without the bound, a page deep into a list read every row from the start of the range up to the marker and threw
    // them away (CH 26.8: `(a, b) > (x, y)` does not narrow the granules; `a >= x` does)
    const { clause } = keysetClause(KEYS, false, [4_000_000, 7]);
    expect(clause.startsWith('ledger_index >= {k0:UInt32} AND ')).toBe(true);
  });

  it('compares the other way when descending', () => {
    expect(keysetClause(KEYS, true, [4_000_000, 7]).clause).toBe(
      'ledger_index <= {k0:UInt32} AND (ledger_index, tx_index) < ({k0:UInt32}, {k1:UInt16})',
    );
  });

  it('prefixes the param names so that a query can hold two clauses', () => {
    expect(keysetClause(KEYS, false, [1, 2], 'after_')).toEqual({
      clause: 'ledger_index >= {after_0:UInt32} AND (ledger_index, tx_index) > ({after_0:UInt32}, {after_1:UInt16})',
      params: { after_0: 1, after_1: 2 },
    });
  });

  it('types each param by its key and keeps strings out of the SQL text', () => {
    const keys: KeysetKey[] = [
      { column: 'validation_public_key', type: 'String' },
      { column: 'ledger_index', type: 'UInt32' },
    ];
    const { clause, params } = keysetClause(keys, false, ["n9'; DROP TABLE x; --", 3]);
    expect(clause).toBe(
      'validation_public_key >= {k0:String} AND (validation_public_key, ledger_index) > ({k0:String}, {k1:UInt32})',
    );
    expect(clause).not.toContain('DROP');
    expect(params).toEqual({ k0: "n9'; DROP TABLE x; --", k1: 3 });
  });

  it('works for a single column', () => {
    expect(keysetClause([{ column: 'account', type: 'String' }], false, ['rA']).clause).toBe(
      '(account) > ({k0:String})',
    );
  });

  it('refuses values that do not fit the keys instead of silently paging from the start', () => {
    expect(() => keysetClause(KEYS, false, [1])).toThrow(/2 columns.*1 value/);
  });
});

describe('keysetClause with a null', () => {
  it('refuses a null: a tuple comparison does not compare it, the list that has one builds its own condition', () => {
    expect(() => keysetClause(KEYS, false, [null, 2])).toThrow(/null/);
  });
});

describe('orderByClause', () => {
  it('orders every key the same way', () => {
    expect(orderByClause(KEYS, false)).toBe('ledger_index ASC, tx_index ASC');
    expect(orderByClause(KEYS, true)).toBe('ledger_index DESC, tx_index DESC');
  });
});

describe('paginate', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ledger_index: 100 + i, tx_index: i }));
  const keyOf = (r: { ledger_index: number; tx_index: number }) => [r.ledger_index, r.tx_index];

  it('cuts the extra row and marks the last returned one, when limit + 1 rows came back', () => {
    const page = paginate(rows(4), 3, keyOf);
    expect(page.rows).toEqual(rows(3));
    expect(page.marker).toBeDefined();
    // the next page starts after row 2 and so includes row 3, the one that was fetched only to know there is more
    expect(decodeMarker(page.marker, KEYS)).toEqual([102, 2]);
  });

  it('has no marker when exactly limit rows came back', () => {
    const page = paginate(rows(3), 3, keyOf);
    expect(page.rows).toEqual(rows(3));
    expect(page).not.toHaveProperty('marker');
  });

  it('has no marker when fewer came back, or none', () => {
    expect(paginate(rows(2), 3, keyOf)).toEqual({ rows: rows(2) });
    expect(paginate([], 3, keyOf)).toEqual({ rows: [] });
  });

  it('does not change the rows it is given', () => {
    const fetched = rows(4);
    paginate(fetched, 3, keyOf);
    expect(fetched).toEqual(rows(4));
  });

  it('marks a page of one', () => {
    expect(decodeMarker(paginate(rows(2), 1, keyOf).marker, KEYS)).toEqual([100, 0]);
  });
});

describe('setLinkHeader', () => {
  @Controller()
  class LinkController {
    @Get('v2/things/:id')
    thing(@Req() req: Request, @Res({ passthrough: true }) res: Response): { ok: true } {
      const marker = req.query.next;
      setLinkHeader(req, res, typeof marker === 'string' ? marker : undefined);
      return { ok: true };
    }
  }

  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [LinkController] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });

  const link = async (url: string) =>
    (await request(app.getHttpServer()).get(url).set('Host', 'api.example.com')).headers['link'];

  it('is the url of the request with the marker replaced, as rel="next"', async () => {
    expect(await link('/v2/things/7?next=NEW&limit=2&marker=OLD&descending=true')).toBe(
      '<http://api.example.com/v2/things/7?next=NEW&limit=2&marker=NEW&descending=true>; rel="next"',
    );
  });

  it('adds the marker at the end when the request had none', async () => {
    expect(await link('/v2/things/7?next=NEW&limit=2')).toBe(
      '<http://api.example.com/v2/things/7?next=NEW&limit=2&marker=NEW>; rel="next"',
    );
    expect(await link('/v2/things/7?next=NEW')).toBe(
      '<http://api.example.com/v2/things/7?next=NEW&marker=NEW>; rel="next"',
    );
  });

  it('sets no header without a marker: the last page', async () => {
    expect(await link('/v2/things/7?limit=2&marker=OLD')).toBeUndefined();
  });

  it('keeps the first value of a repeated param, which is the one the route used', async () => {
    expect(await link('/v2/things/7?next=NEW&limit=2&limit=5&marker=OLD&marker=OLDER')).toBe(
      '<http://api.example.com/v2/things/7?next=NEW&limit=2&marker=NEW>; rel="next"',
    );
  });

  it('shows readable values the way Ripple did: a time keeps its colons', async () => {
    expect(await link('/v2/things/7?next=NEW&start=2015-01-14T17%3A29%3A10Z&currency=USD%2BrXYZ')).toBe(
      '<http://api.example.com/v2/things/7?next=NEW&start=2015-01-14T17:29:10Z&currency=USD%2BrXYZ&marker=NEW>; rel="next"',
    );
  });

  it('keeps encoded what would change the url if it were shown: + & # = % and a space', async () => {
    expect(await link('/v2/things/7?next=NEW&start=2015-01-14T00%3A00%3A00%2B00%3A00&q=a%26b%23c%3Dd%25e%20f')).toBe(
      '<http://api.example.com/v2/things/7?next=NEW&start=2015-01-14T00:00:00%2B00:00&q=a%26b%23c%3Dd%25e%20f&marker=NEW>; rel="next"',
    );
  });

  it('keeps non-ASCII text encoded, because a header value cannot hold it', async () => {
    expect(await link('/v2/things/7?next=NEW&q=%C3%A9%E2%82%AC')).toBe(
      '<http://api.example.com/v2/things/7?next=NEW&q=%C3%A9%E2%82%AC&marker=NEW>; rel="next"',
    );
  });

  it('uses the scheme and host the client reached the service by', async () => {
    const res = await request(app.getHttpServer()).get('/v2/things/7?next=NEW');
    expect(res.headers['link']).toMatch(
      /^<http:\/\/127\.0\.0\.1:\d+\/v2\/things\/7\?next=NEW&marker=NEW>; rel="next"$/,
    );
  });
});
