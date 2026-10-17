import { RippleHttpError } from './errors';
import {
  ammConditions,
  ammFilter,
  anyFlag,
  bool,
  dateParam,
  endExclusive,
  first,
  Granularity,
  limitParam,
  parseDate,
  ParsedDate,
  strictFlag,
  uintParam,
} from './params';

/** Runs `fn` and returns the 400 it must throw, as a `[status, message]` pair. */
function thrown(fn: () => unknown): [number, string] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RippleHttpError);
    const err = e as RippleHttpError;
    expect(err.getResponse()).toEqual({ result: 'error', message: expect.any(String) });
    return [err.getStatus(), (err.getResponse() as { message: string }).message];
  }
  throw new Error('expected the call to throw');
}

const iso = (d: Date): string => d.toISOString();

describe('first', () => {
  it.each<[string, Record<string, unknown>, string | undefined]>([
    ['a string', { x: 'a' }, 'a'],
    ['an empty string', { x: '' }, ''],
    ['the first of a repeated param', { x: ['a', 'b'] }, 'a'],
    ['the first of a repeated param, even when empty', { x: ['', 'b'] }, ''],
    ['a number as text', { x: 5000 }, '5000'],
    ['a boolean as text', { x: true }, 'true'],
    ['nothing for a missing param', {}, undefined],
    ['nothing for an empty list', { x: [] }, undefined],
    ['nothing for an object (?x[a]=b)', { x: { a: 'b' } }, undefined],
    ['nothing for null', { x: null }, undefined],
  ])('returns %s', (_name, query, expected) => {
    expect(first(query, 'x')).toBe(expected);
  });

  it('does not read inherited properties', () => {
    expect(first({}, 'constructor')).toBeUndefined();
    expect(first({}, '__proto__')).toBeUndefined();
  });
});

describe('bool', () => {
  it.each<[unknown, boolean]>([
    ['true', true],
    ['TRUE', true],
    ['True', true],
    [true, true],
    // Ripple tests /true/i, which is not anchored.
    ['xtruex', true],
    [['true', 'false'], true],
    [['false', 'true'], false],
    ['1', false],
    ['yes', false],
    ['false', false],
    ['', false],
    [undefined, false],
  ])('%j -> %s', (value, expected) => {
    expect(bool({ binary: value }, 'binary')).toBe(expected);
  });

  it('is false for a missing param', () => {
    expect(bool({}, 'binary')).toBe(false);
  });
});

describe('strictFlag', () => {
  it.each<[unknown, boolean]>([
    ['no', true],
    ['0', true],
    ['', true],
    ['true', true],
    [undefined, true],
    ['false', false],
    ['FALSE', false],
    ['False', false],
    // like `bool`, Ripple's /false/i is not anchored
    ['notfalse', false],
    [['false', 'true'], false],
    [['true', 'false'], true],
  ])('strict=%j -> %s', (value, expected) => {
    expect(strictFlag({ strict: value })).toBe(expected);
  });

  it('is true when the param is missing', () => {
    expect(strictFlag({})).toBe(true);
  });
});

describe('anyFlag', () => {
  it.each<[unknown, boolean]>([
    ['0', true],
    ['false', true],
    ['x', true],
    [' ', true],
    ['', false],
    [undefined, false],
    [['', 'x'], false],
    [['x', ''], true],
  ])('include_exchanges=%j -> %s', (value, expected) => {
    expect(anyFlag({ include_exchanges: value }, 'include_exchanges')).toBe(expected);
  });

  it('is false for a missing param', () => {
    expect(anyFlag({}, 'include_exchanges')).toBe(false);
  });
});

describe('limitParam', () => {
  const opts = { def: 200, max: 1000 };

  it.each<[string, unknown, number]>([
    ['the default when missing', undefined, 200],
    ['the default when empty', '', 200],
    ['the default for text', 'abc', 200],
    ['the default for an empty list', [], 200],
    ['the value', '50', 50],
    ['a numeric value', 50, 50],
    ['the first of a repeated param', ['7', '9'], 7],
    ['the max itself', '1000', 1000],
    ['the max for more than the max', 5000, 1000],
    ['the max for more than the max, as text', '5000', 1000],
    ['the max for Infinity', 'Infinity', 1000],
    ['the max for an exponent form above the max', '1e4', 1000],
    ['a value in exponent form', '1e2', 100],
    ['the default for zero', '0', 200],
    ['the default for a negative number', '-5', 200],
    ['the whole part of a decimal', '2.9', 2],
    ['the default for a decimal below one', '0.5', 200],
    ['the default for all without allowAll', 'all', 200],
  ])('gives %s', (_name, value, expected) => {
    expect(limitParam({ limit: value }, opts)).toBe(expected);
  });

  it('gives the default when the param is missing', () => {
    expect(limitParam({}, opts)).toBe(200);
  });

  it('gives the max for "all" when allowAll is set', () => {
    expect(limitParam({ limit: 'all' }, { def: 200, max: 400, allowAll: true })).toBe(400);
  });

  it('matches "all" exactly, as Ripple does', () => {
    expect(limitParam({ limit: 'ALL' }, { def: 200, max: 400, allowAll: true })).toBe(200);
    expect(
      thrown(() => limitParam({ limit: 'ALL' }, { def: 200, max: 400, allowAll: true, nanError: 'invalid limit' })),
    ).toEqual([400, 'invalid limit']);
  });

  describe('with nanError', () => {
    const strictOpts = { def: 200, max: 400, nanError: 'invalid limit: NaN' };

    it.each([['abc'], ['1x'], ['all'], ['NaN']])('answers 400 with its text for %j', (value) => {
      expect(thrown(() => limitParam({ limit: value }, strictOpts))).toEqual([400, 'invalid limit: NaN']);
    });

    it.each<[string, unknown, number]>([
      ['missing', undefined, 200],
      ['empty', '', 200],
      ['a number', '10', 10],
      ['over the max', '999', 400],
    ])('still gives a number for %s', (_name, value, expected) => {
      expect(limitParam({ limit: value }, strictOpts)).toBe(expected);
    });
  });
});

describe('parseDate', () => {
  // The expected values follow smoment.js: moment strict parsing of these formats, in UTC.
  it.each<[string, string, Granularity]>([
    ['2015', '2015-01-01T00:00:00.000Z', 'year'],
    ['2015-01', '2015-01-01T00:00:00.000Z', 'month'],
    ['2015-12', '2015-12-01T00:00:00.000Z', 'month'],
    ['2015-01-14', '2015-01-14T00:00:00.000Z', 'day'],
    ['2016-02-29', '2016-02-29T00:00:00.000Z', 'day'],
    ['2015-01-14T18', '2015-01-14T18:00:00.000Z', 'hour'],
    ['2015-01-14T18:28', '2015-01-14T18:28:00.000Z', 'minute'],
    ['2015-01-14T18:28:40', '2015-01-14T18:28:40.000Z', 'second'],
    ['2015-01-14T18:28:40Z', '2015-01-14T18:28:40.000Z', 'second'],
    ['2015-01-14T18:28:40.123Z', '2015-01-14T18:28:40.123Z', 'ms'],
    ['2015-01-14T18:28:40.000Z', '2015-01-14T18:28:40.000Z', 'ms'],
    ['20150114182840', '2015-01-14T18:28:40.000Z', 'second'],
    ['20150114182840123', '2015-01-14T18:28:40.123Z', 'ms'],
    // 10 digits are unix seconds, not a date
    ['1421260120', '2015-01-14T18:28:40.000Z', 'second'],
    ['0000000000', '1970-01-01T00:00:00.000Z', 'second'],
    ['1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z', 'second'],
    // an offset is converted to UTC
    ['2015-01-14T18:28:40+02:00', '2015-01-14T16:28:40.000Z', 'second'],
    ['2015-01-14T18:28:40+0200', '2015-01-14T16:28:40.000Z', 'second'],
    ['2015-01-14T18:28:40+02', '2015-01-14T16:28:40.000Z', 'second'],
    ['2015-01-14T18:28:40-05:30', '2015-01-14T23:58:40.000Z', 'second'],
    ['2015-01-14T18:28:40.123+01:00', '2015-01-14T17:28:40.123Z', 'ms'],
    ['2015-01-14T18:28:40+14:00', '2015-01-14T04:28:40.000Z', 'second'],
    ['2015-01-14T18:28:40-12:00', '2015-01-15T06:28:40.000Z', 'second'],
    // a lower-case z is a zone designator, as in moment
    ['2015-01-14T18:28:40z', '2015-01-14T18:28:40.000Z', 'second'],
    // hour 24 is midnight of the next day
    ['2015-01-14T24:00', '2015-01-15T00:00:00.000Z', 'minute'],
    ['2015-01-14T24:00:00', '2015-01-15T00:00:00.000Z', 'second'],
    ['2015-12-31T24:00:00.000Z', '2016-01-01T00:00:00.000Z', 'ms'],
    // years before 100 are not read as 19xx
    ['0050', '0050-01-01T00:00:00.000Z', 'year'],
  ])('accepts %s', (raw, expected, granularity) => {
    const parsed = parseDate(raw);
    expect(parsed).toBeDefined();
    expect(iso((parsed as ParsedDate).date)).toBe(expected);
    expect((parsed as ParsedDate).granularity).toBe(granularity);
  });

  it.each([
    ['2015-13-01', 'month 13'],
    ['2015-00-10', 'month 0'],
    ['2015-01-00', 'day 0'],
    ['2015-02-29', 'Feb 29 in a common year'],
    ['2015-04-31', 'Apr 31'],
    ['2015-01-14T25', 'hour 25'],
    ['2015-01-14T24:01', 'hour 24 with minutes'],
    ['2015-01-14T24:00:01', 'hour 24 with seconds'],
    ['2015-01-14T18:60', 'minute 60'],
    ['2015-12-31T23:59:60', 'second 60'],
    ['yesterday', 'text'],
    ['', 'empty'],
    [' 2015', 'leading space'],
    ['2015 ', 'trailing space'],
    ['2015-1-4', 'unpadded'],
    ['15', 'two-digit year'],
    ['201', 'three-digit year'],
    ['12345', 'five digits'],
    ['-2015', 'signed year'],
    ['2015-01-14 18:28:40', 'space instead of T'],
    ['2015-01-14t18:28:40', 'lower-case t'],
    ['2015-01-14t18:28:40Z', 'lower-case t with a zone'],
    ['2015-01-14t18:28:40.123Z', 'lower-case t with milliseconds'],
    ['2015-01-14T18:28:40Z ', 'trailing space after Z'],
    ['2015-01-14T18:28:40.1Z', 'one fraction digit'],
    ['2015-01-14T18:28:40.123456Z', 'six fraction digits'],
    ['2015-01-14T18:28:40.123', 'fraction without a zone'],
    ['2015-01-14T18Z', 'hour with a zone'],
    ['2015-01-14T18:28Z', 'minute with a zone'],
    ['2015-01-14Z', 'day with a zone'],
    ['2015-01-14T18:28:40+2', 'one-digit offset'],
    ['2015-01-14T18:28:40 +02:00', 'space before the offset'],
    ['2015-01-14T18:28:40+02:60', 'offset minutes 60'],
    ['2015-01-14T18:28:40+14:01', 'offset above +14:00'],
    ['2015-01-14T18:28:40-12:01', 'offset below -12:00'],
    ['20150114', '8 digits'],
    ['201501141828', '12 digits'],
    ['2015011418284', '13 digits'],
    ['142126012', '9 digits'],
    ['14212601200', '11 digits'],
    ['20151314182840', '14 digits with month 13'],
    ['20150229182840', '14 digits on Feb 29 of a common year'],
    ['201501141828401', '15 digits'],
    ['2015011418284012', '16 digits'],
    ['\u0662\u0660\u0661\u0665', 'non-ASCII digits'],
    ['0x5a0b1c2d', 'hex'],
    ['1421260120\n', 'unix seconds with a newline'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseDate(raw)).toBeUndefined();
  });
});

describe('endExclusive', () => {
  const at = (date: string, granularity: Granularity): ParsedDate => ({ date: new Date(date), granularity });

  it.each<[string, Granularity, string]>([
    ['2015-08-31T00:00:00Z', 'day', '2015-09-01T00:00:00.000Z'],
    ['2015-12-31T00:00:00Z', 'day', '2016-01-01T00:00:00.000Z'],
    ['2016-02-28T00:00:00Z', 'day', '2016-02-29T00:00:00.000Z'],
    ['2015-02-28T00:00:00Z', 'day', '2015-03-01T00:00:00.000Z'],
    ['2015-01-01T00:00:00Z', 'year', '2016-01-01T00:00:00.000Z'],
    ['2015-01-01T00:00:00Z', 'month', '2015-02-01T00:00:00.000Z'],
    ['2015-12-01T00:00:00Z', 'month', '2016-01-01T00:00:00.000Z'],
    ['2015-01-14T18:00:00Z', 'hour', '2015-01-14T19:00:00.000Z'],
    ['2015-01-14T23:00:00Z', 'hour', '2015-01-15T00:00:00.000Z'],
    ['2015-01-14T18:28:00Z', 'minute', '2015-01-14T18:29:00.000Z'],
    ['2015-01-14T18:59:00Z', 'minute', '2015-01-14T19:00:00.000Z'],
    ['2015-01-14T18:28:40Z', 'second', '2015-01-14T18:28:41.000Z'],
    ['2015-01-14T23:59:59Z', 'second', '2015-01-15T00:00:00.000Z'],
    ['2015-01-14T18:28:40.123Z', 'ms', '2015-01-14T18:28:40.124Z'],
    ['2015-01-14T18:28:40.999Z', 'ms', '2015-01-14T18:28:41.000Z'],
    // month and year arithmetic keeps a day that exists, as moment does
    ['2015-01-31T00:00:00Z', 'month', '2015-02-28T00:00:00.000Z'],
    ['2016-01-31T00:00:00Z', 'month', '2016-02-29T00:00:00.000Z'],
    ['2016-02-29T00:00:00Z', 'year', '2017-02-28T00:00:00.000Z'],
  ])('%s + 1 %s = %s', (start, granularity, expected) => {
    expect(iso(endExclusive(at(start, granularity)))).toBe(expected);
  });

  it.each<[string, string]>([
    ['2015-08-31', '2015-09-01T00:00:00.000Z'],
    ['2015', '2016-01-01T00:00:00.000Z'],
    ['2015-02', '2015-03-01T00:00:00.000Z'],
    ['2015-01-14T18', '2015-01-14T19:00:00.000Z'],
    ['2015-01-14T18:28', '2015-01-14T18:29:00.000Z'],
    ['2015-01-14T18:28:40Z', '2015-01-14T18:28:41.000Z'],
    ['2015-01-14T18:28:40.123Z', '2015-01-14T18:28:40.124Z'],
    ['1421260120', '2015-01-14T18:28:41.000Z'],
    ['20150114182840', '2015-01-14T18:28:41.000Z'],
  ])('ends %s at %s', (raw, expected) => {
    expect(iso(endExclusive(parseDate(raw) as ParsedDate))).toBe(expected);
  });

  it('returns a new date and leaves its input alone', () => {
    const p = Object.freeze({ date: Object.freeze(new Date('2015-08-31T00:00:00Z')), granularity: 'day' as const });
    const end = endExclusive(p);
    expect(end).not.toBe(p.date);
    expect(iso(p.date)).toBe('2015-08-31T00:00:00.000Z');
  });
});

describe('dateParam', () => {
  const ERR = 'invalid start date format';

  it('is undefined when the param is missing', () => {
    expect(dateParam({}, 'start', ERR)).toBeUndefined();
  });

  it('parses the param', () => {
    const p = dateParam({ start: '2015-01-14' }, 'start', ERR) as ParsedDate;
    expect(iso(p.date)).toBe('2015-01-14T00:00:00.000Z');
    expect(p.granularity).toBe('day');
  });

  it('takes the first of a repeated param', () => {
    const p = dateParam({ end: ['2015-01', '2016'] }, 'end', 'invalid end date format') as ParsedDate;
    expect(p.granularity).toBe('month');
  });

  it.each([['yesterday'], ['2015-13-01'], ['']])('answers 400 with the given text for %j', (raw) => {
    expect(thrown(() => dateParam({ start: raw }, 'start', ERR))).toEqual([400, ERR]);
  });

  it('answers 400 for an invalid first value even when a later one is valid', () => {
    expect(thrown(() => dateParam({ start: ['nope', '2015'] }, 'start', ERR))).toEqual([400, ERR]);
  });

  describe('with a default', () => {
    it('uses it when the param is missing or empty, as Ripple does for `start || default`', () => {
      for (const query of [{}, { start: '' }, { start: undefined }]) {
        const p = dateParam(query, 'start', ERR, '2013-01-01');
        expect(iso(p.date)).toBe('2013-01-01T00:00:00.000Z');
      }
    });

    it('prefers the param', () => {
      expect(iso(dateParam({ start: '2015' }, 'start', ERR, '2013-01-01').date)).toBe('2015-01-01T00:00:00.000Z');
    });

    it('still answers 400 for an invalid param', () => {
      expect(thrown(() => dateParam({ start: 'x' }, 'start', ERR, '2013-01-01'))).toEqual([400, ERR]);
    });
  });
});

describe('uintParam', () => {
  const ERR = 'invalid min_sequence';

  it.each<[string, unknown, number | undefined]>([
    ['missing', undefined, undefined],
    ['empty', '', undefined],
    ['zero', '0', 0],
    ['a number', '12', 12],
    ['leading zeros', '007', 7],
    ['a numeric value', 12, 12],
    ['the first of a repeated param', ['3', 'x'], 3],
    ['the largest safe integer', '9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('reads %s', (_name, value, expected) => {
    expect(uintParam({ min_sequence: value }, 'min_sequence', ERR)).toBe(expected);
  });

  it('is undefined when the param is not in the query', () => {
    expect(uintParam({}, 'min_sequence', ERR)).toBeUndefined();
  });

  it.each([['-1'], ['1.5'], ['abc'], ['1e3'], [' 1'], ['1 '], ['0x10'], ['+1'], ['9007199254740993'], [['x', '1']]])(
    'answers 400 with the given text for %j',
    (value) => {
      expect(thrown(() => uintParam({ min_sequence: value }, 'min_sequence', ERR))).toEqual([400, ERR]);
    },
  );
});

describe('ammFilter', () => {
  it.each(['include', 'exclude', 'only'] as const)('accepts %s', (value) => {
    expect(ammFilter({ amm: value })).toBe(value);
  });

  it('is include when the param is missing or empty (swaps against pools are exchanges, so they are listed)', () => {
    expect(ammFilter({})).toBe('include');
    expect(ammFilter({ amm: '' })).toBe('include');
    expect(ammFilter({ amm: undefined })).toBe('include');
  });

  it('takes the first of a repeated param, like every param of the routes', () => {
    expect(ammFilter({ amm: ['only', 'exclude'] })).toBe('only');
    expect(thrown(() => ammFilter({ amm: ['nope', 'only'] }))).toEqual([
      400,
      'invalid amm filter - use: include, exclude, only',
    ]);
  });

  it.each(['ONLY', 'Include', 'excluded', 'true', '1', ' only', 'only ', 'none', '*'])(
    'answers 400 for %j: anything but the three values',
    (value) => {
      expect(thrown(() => ammFilter({ amm: value }))).toEqual([
        400,
        'invalid amm filter - use: include, exclude, only',
      ]);
    },
  );

  it('reads no other param', () => {
    expect(ammFilter({ other: 'only', autobridged: 'true' })).toBe('include');
  });
});

describe('ammConditions', () => {
  it('is no condition for include, and a plain condition on amm_account for the others', () => {
    expect(ammConditions('include')).toEqual([]);
    expect(ammConditions('only')).toEqual(["amm_account != ''"]);
    expect(ammConditions('exclude')).toEqual(["amm_account = ''"]);
  });
});
