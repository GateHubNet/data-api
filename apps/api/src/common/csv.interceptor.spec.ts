import { Get, INestApplication, Req, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request, Response } from 'express';
import { convert, expressDecorator } from 'nice-json2csv';
import request from 'supertest';
import { Csv, csvContentDisposition, CsvInterceptor, flattenJSON, wantsCsv } from './csv.interceptor';
import { badRequest } from './errors';
import { RippleController } from './ripple-controller';

const INTERCEPTORS_METADATA = '__interceptors__';

const NESTED = [{ a: { b: 1 }, c: [{ d: 2 }] }];
const ODD = [
  {
    text: 'say "hi", ok',
    n: 1.5,
    yes: true,
    nothing: null,
    missing: undefined,
    obj: {},
    list: [],
    items: ['x', 'y'],
    zero: 0,
    unicode: 'Zürich €',
  },
];

@RippleController('v2/rows')
class RowsController {
  @Get('nested')
  @Csv('nested', 'rows')
  nested() {
    return { result: 'success', count: 1, rows: NESTED };
  }

  @Get('odd')
  @Csv('odd', 'rows')
  odd() {
    return { result: 'success', rows: ODD };
  }

  @Get('mixed')
  @Csv('mixed', 'rows')
  mixed() {
    return { result: 'success', rows: [{ a: 1 }, { b: 2, a: 3 }, { c: { d: 4 } }] };
  }

  @Get('empty')
  @Csv('empty', 'rows')
  empty() {
    return { result: 'success', count: 0, rows: [] };
  }

  @Get('no-rows')
  @Csv('no-rows', 'rows')
  noRows() {
    return { result: 'success' };
  }

  @Get('single')
  @Csv('single', 'account_data')
  single() {
    return { result: 'success', account_data: { account: 'rA', balance: { value: '5' } } };
  }

  @Get('named')
  @Csv((req, body) => `${req.query.account} - ${body.count} rows`, 'rows')
  named(@Req() req: Request) {
    return { result: 'success', count: 1, rows: [{ x: req.query.account }] };
  }

  @Get('named-by-query')
  @Csv((req) => String(req.query.name), 'rows')
  namedByQuery() {
    return { result: 'success', rows: [{ x: 1 }] };
  }

  @Get('hostile-name')
  @Csv(() => 'line\nbreak € "quoted"', 'rows')
  hostileName() {
    return { result: 'success', rows: [{ x: 1 }] };
  }

  /** The route of the original: the flattened rows through `res.csv` of nice-json2csv, the oracle for the headers. */
  @Get('original')
  original(@Res() res: Response & { csv(data: unknown, fileName: string): void }): void {
    res.csv([flattenJSON(NESTED[0])], 'nested.csv');
  }

  @Get('fails')
  @Csv('fails', 'rows')
  fails(): never {
    throw badRequest('invalid start date format');
  }
}

describe('Csv', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [RowsController] }).compile();
    app = moduleRef.createNestApplication();
    app.use(expressDecorator);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });

  const get = (url: string) => request(app.getHttpServer()).get(url);

  /** The file name a client reads from a Content-Disposition: the UTF-8 `filename*` (RFC 6266 prefers it). */
  const fileNameOf = (header: string): string =>
    decodeURIComponent(/filename\*=UTF-8''([^;]*)/.exec(header)?.[1] ?? 'no filename* in the header');

  it('adds one CsvInterceptor to the route', () => {
    const metadata = Reflect.getMetadata(INTERCEPTORS_METADATA, RowsController.prototype.nested);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toBeInstanceOf(CsvInterceptor);
  });

  describe('without format=csv', () => {
    it.each([
      '/v2/rows/nested',
      '/v2/rows/nested?format=json',
      '/v2/rows/nested?format=',
      '/v2/rows/nested?format=xml',
    ])('leaves %s as the JSON body', async (url) => {
      const res = await get(url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.body).toEqual({ result: 'success', count: 1, rows: NESTED });
    });
  });

  describe('with format=csv', () => {
    it('answers text/csv as an attachment named after the route, like res.csv of nice-json2csv', async () => {
      const res = await get('/v2/rows/nested?format=csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="nested.csv"; filename*=UTF-8''nested.csv`);
      expect(res.text).toBe(String.raw`"a.b","c[0].d"` + '\n' + `"1","2"`);
    });

    it('answers exactly what res.csv of nice-json2csv answered in the original: headers and body', async () => {
      const original = await get('/v2/rows/original');
      const ours = await get('/v2/rows/nested?format=csv');
      expect(original.headers['content-disposition']).toBe('attachment; filename=nested.csv');
      for (const header of ['content-type', 'content-length', 'etag']) {
        expect(ours.headers[header]).toBeDefined();
        expect(ours.headers[header]).toBe(original.headers[header]);
      }
      // the same file name, quoted and also given as UTF-8 (M12): the original's was unquoted
      expect(fileNameOf(ours.headers['content-disposition'])).toBe('nested.csv');
      expect(ours.text).toBe(original.text);
      expect(ours.status).toBe(original.status);
    });

    it('is the output of nice-json2csv for the rows with their nested fields flattened to a.b and a[0].c', async () => {
      const res = await get('/v2/rows/nested?format=csv');
      expect(res.text).toBe(convert([{ 'a.b': 1, 'c[0].d': 2 }]));
      expect(res.text.split('\n')[0]).toBe('"a.b","c[0].d"');
    });

    it.each(['CSV', 'Csv', 'cSv'])('accepts %s, because the original lowercased the format', async (format) => {
      const res = await get(`/v2/rows/nested?format=${format}`);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
    });

    it('goes by the first value of a repeated format', async () => {
      expect((await get('/v2/rows/nested?format=csv&format=json')).headers['content-type']).toMatch(/^text\/csv/);
      expect((await get('/v2/rows/nested?format=json&format=csv')).headers['content-type']).toMatch(
        /^application\/json/,
      );
    });

    it('takes the columns of all rows, in the order they first appear, and leaves a gap where a row lacks one', async () => {
      const res = await get('/v2/rows/mixed?format=csv');
      expect(res.text).toBe(convert([{ a: 1 }, { b: 2, a: 3 }, { 'c.d': 4 }]));
      expect(res.text).toBe('"a","b","c.d"\n"1","",""\n"3","2",""\n"","","4"');
    });

    it('writes what nice-json2csv writes for strings with quotes and commas, null, booleans, {} and []', async () => {
      const res = await get('/v2/rows/odd?format=csv');
      // undefined is not a column (JSON drops it too), null is an empty cell, {} is [Object], an empty list is gone
      // (the original flattenJSON never reaches its `l == 0` branch)
      const oracle = convert([
        {
          text: 'say "hi", ok',
          n: 1.5,
          yes: true,
          nothing: null,
          obj: {},
          'items[0]': 'x',
          'items[1]': 'y',
          zero: 0,
          unicode: 'Zürich €',
        },
      ]);
      expect(res.text).toBe(oracle);
      expect(res.text.split('\n')).toEqual([
        '"text","n","yes","nothing","obj","items[0]","items[1]","zero","unicode"',
        String.raw`"say \"hi\", ok","1.5","true","","[Object]","x","y","0","Zürich €"`,
      ]);
    });

    it('answers an empty body when there are no rows, still as a CSV attachment', async () => {
      for (const route of ['empty', 'no-rows']) {
        const res = await get(`/v2/rows/${route}?format=csv`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/csv/);
        expect(res.headers['content-disposition']).toBe(
          `attachment; filename="${route}.csv"; filename*=UTF-8''${route}.csv`,
        );
        expect(res.text).toBe('');
      }
    });

    it('turns a single object under the key into one row', async () => {
      const res = await get('/v2/rows/single?format=csv');
      expect(res.text).toBe('"account","balance.value"\n"rA","5"');
    });

    it('lets the route name the file from the request and the body', async () => {
      const res = await get('/v2/rows/named?format=csv&account=rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh - 1 rows.csv"; ` +
          `filename*=UTF-8''rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh%20-%201%20rows.csv`,
      );
      expect(fileNameOf(res.headers['content-disposition'])).toBe('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh - 1 rows.csv');
      expect(res.text).toBe('"x"\n"rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"');
    });

    it('replaces a control character of a file name, quotes the name and gives it in UTF-8 too (M12)', async () => {
      const res = await get('/v2/rows/hostile-name?format=csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        String.raw`attachment; filename="line_break _ \"quoted\".csv"; ` +
          `filename*=UTF-8''line_break%20%E2%82%AC%20%22quoted%22.csv`,
      );
      expect(fileNameOf(res.headers['content-disposition'])).toBe('line_break € "quoted".csv');
    });

    it('a lone surrogate in a name is replaced instead of failing the route', () => {
      expect(csvContentDisposition('a\uD800b')).toBe(`attachment; filename="a_b.csv"; filename*=UTF-8''a_b.csv`);
    });

    it.each([
      ['a semicolon', 'USD; x=1', `filename="USD; x=1.csv"; filename*=UTF-8''USD%3B%20x%3D1.csv`],
      ['a quote and a backslash', 'a"b\\c', String.raw`filename="a\"b\\c.csv"; filename*=UTF-8''a%22b%5Cc.csv`],
      [
        'spaces',
        'payments - USD rIssuer',
        `filename="payments - USD rIssuer.csv"; filename*=UTF-8''payments%20-%20USD%20rIssuer.csv`,
      ],
      ['non-ASCII text', 'Zürich €', `filename="Z_rich _.csv"; filename*=UTF-8''Z%C3%BCrich%20%E2%82%AC.csv`],
      [
        "what RFC 5987 does not allow raw: ' ( ) *",
        "o'k (1)*",
        `filename="o'k (1)*.csv"; filename*=UTF-8''o%27k%20%281%29%2A.csv`,
      ],
    ])(
      'a name with %s is one parameter, and the UTF-8 form is the name itself (M12)',
      async (_what, name, expected) => {
        const res = await get(`/v2/rows/named-by-query?format=csv&name=${encodeURIComponent(name)}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toBe(`attachment; ${expected}`);
        expect(fileNameOf(res.headers['content-disposition'])).toBe(`${name}.csv`);
      },
    );

    it('leaves an error of the route alone: the Ripple error body and status, no CSV', async () => {
      const res = await get('/v2/rows/fails?format=csv');
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.body).toEqual({ result: 'error', message: 'invalid start date format' });
    });
  });
});

describe('flattenJSON', () => {
  it('joins object keys with a dot and array positions in brackets', () => {
    expect(flattenJSON({ a: { b: 1 }, c: [{ d: 2 }, { d: 3 }], e: ['x'] })).toEqual({
      'a.b': 1,
      'c[0].d': 2,
      'c[1].d': 3,
      'e[0]': 'x',
    });
    expect(flattenJSON({ a: { b: { c: { d: 'deep' } } } })).toEqual({ 'a.b.c.d': 'deep' });
  });

  it('keeps the order of the keys', () => {
    expect(Object.keys(flattenJSON({ z: 1, a: { y: 2, b: 3 }, m: 4 }))).toEqual(['z', 'a.y', 'a.b', 'm']);
  });

  it('keeps null and every other scalar, and an empty object as {}', () => {
    expect(flattenJSON({ n: null, s: '', z: 0, f: false, o: {}, p: { q: {} } })).toEqual({
      n: null,
      s: '',
      z: 0,
      f: false,
      o: {},
      'p.q': {},
    });
  });

  it('drops an empty array, as the original did, and undefined, as JSON does', () => {
    // `d` has keys, so it is not an empty object either: it leaves nothing
    expect(Object.keys(flattenJSON({ a: [], b: undefined, c: 1, d: { e: [], f: undefined } }))).toEqual(['c']);
  });

  it('does not change its input', () => {
    const input = Object.freeze({ a: Object.freeze({ b: Object.freeze([1]) }) });
    expect(flattenJSON(input)).toEqual({ 'a.b[0]': 1 });
  });

  it('is safe for a key such as __proto__ in data: it stays a key and sets no prototype', () => {
    const out = flattenJSON(JSON.parse('{"__proto__":{},"x":1,"y":{"__proto__":{"polluted":true}}}'));
    expect(Object.keys(out)).toEqual(['__proto__', 'x', 'y.__proto__.polluted']);
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('wantsCsv', () => {
  it('is format=csv in any case, by the first value', () => {
    expect(wantsCsv({ format: 'csv' })).toBe(true);
    expect(wantsCsv({ format: 'CSV' })).toBe(true);
    expect(wantsCsv({ format: ['Csv', 'json'] })).toBe(true);
  });

  it('is false for anything else', () => {
    for (const q of [{}, { format: 'json' }, { format: '' }, { format: ['json', 'csv'] }, { format: { csv: '1' } }]) {
      expect(wantsCsv(q)).toBe(false);
    }
  });
});
