import { RippleHttpError } from '../common/errors';
import {
  DATE_TOO_OLD,
  ledgerSelector,
  liveCacheKey,
  liveLimit,
  liveNodeError,
  rippledErrorCode,
} from './account-ledger';

const HASH = 'BC79855472F0724120FD1196BE6C25E4EB74C4BEEAF5499F5BEECF65139ADF20';

/** The error a route answers with: its status and Ripple message. */
function raised(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof RippleHttpError)
      return { status: err.getStatus(), message: (err.getResponse() as { message: string }).message };
    throw err;
  }
  throw new Error('did not throw');
}

describe('ledgerSelector', () => {
  it('names nothing without params', () => {
    expect(ledgerSelector({})).toEqual({});
    expect(ledgerSelector({ ledger_index: '', ledger: '', ledger_hash: '', date: '', close_time: '' })).toEqual({});
  });

  it('ledger_index is a ledger number or a word of the node; ledger is its alias, used when it is empty', () => {
    expect(ledgerSelector({ ledger_index: '123' })).toEqual({ index: 123 });
    expect(ledgerSelector({ ledger: '123' })).toEqual({ index: 123 });
    expect(ledgerSelector({ ledger_index: '5', ledger: '6' })).toEqual({ index: 5 });
    expect(ledgerSelector({ ledger_index: '', ledger: '6' })).toEqual({ index: 6 });
    expect(ledgerSelector({ ledger_index: '0' })).toEqual({ index: 0 });
    expect(ledgerSelector({ ledger_index: '4294967295' })).toEqual({ index: 4_294_967_295 });
    for (const word of ['validated', 'closed', 'current']) {
      expect(ledgerSelector({ ledger_index: word })).toEqual({ index: word });
    }
  });

  it('a ledger_index that is no ledger selects none (the original sent NaN)', () => {
    for (const junk of [
      'latest',
      'Validated',
      '-1',
      '1.5',
      '1e3',
      ' 5',
      '5 ',
      '0x10',
      '4294967296',
      '99999999999',
      'NaN',
    ]) {
      expect(ledgerSelector({ ledger_index: junk })).toEqual({});
    }
  });

  it('ledger_hash is 64 hex digits, sent in upper case', () => {
    expect(ledgerSelector({ ledger_hash: HASH })).toEqual({ hash: HASH });
    expect(ledgerSelector({ ledger_hash: HASH.toLowerCase() })).toEqual({ hash: HASH });
    for (const bad of ['abc', HASH.slice(1), `${HASH}0`, `${HASH.slice(1)}G`, ` ${HASH.slice(1)}`]) {
      expect(raised(() => ledgerSelector({ ledger_hash: bad }))).toEqual({
        status: 400,
        message: 'invalid ledger hash',
      });
    }
  });

  it('date is a date of Ripple, close_time its alias that wins', () => {
    expect(ledgerSelector({ date: '2015-01-14T17:29:10Z' })).toEqual({ date: new Date('2015-01-14T17:29:10Z') });
    expect(ledgerSelector({ date: '2015-01-14' })).toEqual({ date: new Date('2015-01-14T00:00:00Z') });
    expect(ledgerSelector({ date: '1421256550' })).toEqual({ date: new Date(1_421_256_550_000) });
    expect(ledgerSelector({ close_time: '2015-01-14', date: '2016-01-01' })).toEqual({
      date: new Date('2015-01-14T00:00:00Z'),
    });
    expect(ledgerSelector({ close_time: '', date: '2016-01-01' })).toEqual({ date: new Date('2016-01-01T00:00:00Z') });
    for (const bad of ['yesterday', '2015-13-01', '2015-02-30', '20150114', '2015-01-14 17:29:10']) {
      expect(raised(() => ledgerSelector({ date: bad }))).toEqual({ status: 400, message: 'invalid date format' });
    }
  });

  it('a date is checked before a hash, as the original checked the date and never the hash', () => {
    expect(raised(() => ledgerSelector({ date: 'nope', ledger_hash: 'nope' })).message).toBe('invalid date format');
  });

  it('all three at once are all kept, for the resolver to choose', () => {
    expect(ledgerSelector({ ledger_index: '7', ledger_hash: HASH, date: '2015-01-14' })).toEqual({
      hash: HASH,
      date: new Date('2015-01-14T00:00:00Z'),
      index: 7,
    });
  });

  it('the first value of a repeated param wins, and the query is not changed', () => {
    const query = Object.freeze({ ledger_index: Object.freeze(['3', '4']) });
    expect(ledgerSelector(query)).toEqual({ index: 3 });
  });
});

describe('liveLimit', () => {
  it('is 200 by default, at most 400, and says all as undefined', () => {
    expect(liveLimit({})).toBe(200);
    expect(liveLimit({ limit: '' })).toBe(200);
    expect(liveLimit({ limit: '25' })).toBe(25);
    expect(liveLimit({ limit: '400' })).toBe(400);
    expect(liveLimit({ limit: '401' })).toBe(400);
    expect(liveLimit({ limit: '1e6' })).toBe(400);
    expect(liveLimit({ limit: 'Infinity' })).toBe(400);
    expect(liveLimit({ limit: 'all' })).toBeUndefined();
  });

  it('below one is the default, a decimal is cut (R33)', () => {
    expect(liveLimit({ limit: '0' })).toBe(200);
    expect(liveLimit({ limit: '-5' })).toBe(200);
    expect(liveLimit({ limit: '0.5' })).toBe(200);
    expect(liveLimit({ limit: '2.9' })).toBe(2);
  });

  it('a text that is not a number answers 400 invalid limit; all is spelled in lower case', () => {
    for (const bad of ['abc', 'ALL', 'All', 'NaN', '12px', ' all']) {
      expect(raised(() => liveLimit({ limit: bad }))).toEqual({ status: 400, message: 'invalid limit' });
    }
  });
});

describe('liveNodeError', () => {
  const rippled = (error: string) => Object.assign(new Error(error), { name: 'RippledError', data: { error } });

  it('reads the error code of a RippledError', () => {
    expect(rippledErrorCode(rippled('actNotFound'))).toBe('actNotFound');
    expect(rippledErrorCode(new Error('x'))).toBeUndefined();
    expect(rippledErrorCode(undefined)).toBeUndefined();
    expect(rippledErrorCode(null)).toBeUndefined();
    expect(rippledErrorCode('actNotFound')).toBeUndefined();
    expect(rippledErrorCode({ data: { error: 5 } })).toBeUndefined();
  });

  it('actNotFound is 404 account not found, lgrNotFound 400 the date provided is too old', () => {
    expect(raised(() => liveNodeError(rippled('actNotFound')))).toEqual({ status: 404, message: 'account not found' });
    expect(raised(() => liveNodeError(rippled('lgrNotFound')))).toEqual({ status: 400, message: DATE_TOO_OLD });
    expect(DATE_TOO_OLD).toBe('the date provided is too old');
  });

  it('anything else is rethrown as it is', () => {
    for (const err of [
      rippled('actMalformed'),
      rippled('tooBusy'),
      rippled('invalidParams'),
      new Error('socket hang up'),
    ]) {
      let thrown: unknown;
      try {
        liveNodeError(err);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBe(err);
    }
  });
});

describe('liveCacheKey', () => {
  it('tells every part of the request apart, and a missing part from a present one', () => {
    const keys = [
      liveCacheKey('balances', 'rA', { ledger_index: 'validated' }, undefined, undefined, 200),
      liveCacheKey('balances', 'rA', { ledger_index: 'validated' }, undefined, undefined, undefined),
      liveCacheKey('balances', 'rA', { ledger_index: 'validated' }, 'USD', undefined, 200),
      liveCacheKey('balances', 'rA', { ledger_index: 'validated' }, undefined, 'USD', 200),
      liveCacheKey('balances', 'rA', { ledger_index: 7 }, undefined, undefined, 200),
      liveCacheKey('balances', 'rA', { ledger_hash: HASH }, undefined, undefined, 200),
      liveCacheKey('balances', 'rB', { ledger_index: 'validated' }, undefined, undefined, 200),
      liveCacheKey('orders', 'rA', { ledger_index: 'validated' }, undefined, undefined, 200),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(liveCacheKey('orders', 'rA', { ledger_index: 7 }, 5)).toBe(
      liveCacheKey('orders', 'rA', { ledger_index: 7 }, 5),
    );
  });
});
