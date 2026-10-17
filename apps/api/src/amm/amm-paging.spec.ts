import { RippleHttpError } from '../common/errors';
import { encodeMarker } from '../common/pagination';
import {
  carryForward,
  decodePoolsMarker,
  EMPTY_FILL,
  encodePoolsMarker,
  FILLED_COLUMNS,
  FilledValues,
  poolsKeyset,
} from './amm-paging';

const filled = (over: Partial<FilledValues> = {}): FilledValues => ({ ...EMPTY_FILL, ...over });

/** A history row: its own values, the null of a column its transaction did not carry. */
const row = (name: string, own: Partial<FilledValues> = {}): FilledValues & { name: string } => ({
  ...EMPTY_FILL,
  ...own,
  name,
});

describe('carryForward', () => {
  it('a null takes the newest earlier value of its column, and a value stays', () => {
    const rows = [
      row('a', { reserve_base: '10', reserve_counter: '1', trading_fee: 500 }),
      row('b', { reserve_base: '11' }),
      row('c', { reserve_counter: '3', trading_fee: 400 }),
      row('d', {}),
    ];
    const out = carryForward(rows, EMPTY_FILL);
    expect(out.map((r) => [r.name, r.reserve_base, r.reserve_counter, r.trading_fee])).toEqual([
      ['a', '10', '1', 500],
      ['b', '11', '1', 500],
      ['c', '11', '3', 400],
      ['d', '11', '3', 400],
    ]);
  });

  it('starts from the state before the first row: the carry-in fills the nulls of the first rows', () => {
    const carry = filled({
      reserve_base: '9',
      reserve_counter: '8',
      lp_supply: '7',
      lp_currency: '03AB',
      trading_fee: 600,
      auction_holder: 'rHolder',
      auction_price: '2',
      auction_discounted_fee: 60,
      auction_expiration: 5,
    });
    const out = carryForward([row('a', { reserve_base: '10' }), row('b', {})], carry);
    expect(out[0]).toMatchObject({ ...carry, reserve_base: '10' });
    expect(out[1]).toMatchObject({ ...carry, reserve_base: '10' });
  });

  it('a column that was never given stays null', () => {
    const out = carryForward([row('a', { reserve_base: '10' }), row('b', {})], EMPTY_FILL);
    expect(out[1].lp_supply).toBeNull();
    expect(out[1].auction_holder).toBeNull();
  });

  it('zero is a value: a fee of 0, a "0" reserve and a price of "0" are carried and not overwritten', () => {
    const out = carryForward(
      [row('a', { trading_fee: 0, reserve_base: '0', auction_price: '0', auction_expiration: 0 }), row('b', {})],
      filled({ trading_fee: 700, reserve_base: '5', auction_price: '9', auction_expiration: 99 }),
    );
    for (const r of out) {
      expect(r).toMatchObject({ trading_fee: 0, reserve_base: '0', auction_price: '0', auction_expiration: 0 });
    }
  });

  it('is exact over the rows in the order given (time order) and changes neither the rows nor the carry-in', () => {
    const carry = Object.freeze(filled({ reserve_base: '1' }));
    const rows = Object.freeze([Object.freeze(row('a', {})), Object.freeze(row('b', { reserve_base: '2' }))]);
    const out = carryForward(rows, carry);
    expect(out.map((r) => r.reserve_base)).toEqual(['1', '2']);
    expect(rows[0].reserve_base).toBeNull();
    expect(carry.reserve_base).toBe('1');
  });

  it('keeps the other columns of a row (its identity) as they are', () => {
    const out = carryForward([{ ...row('a', {}), ledger_index: 7, deleted: 1 }], filled({ reserve_base: '3' }));
    expect(out[0]).toMatchObject({ name: 'a', ledger_index: 7, deleted: 1, reserve_base: '3' });
  });

  it('knows the nine filled columns of a state', () => {
    expect([...FILLED_COLUMNS].sort()).toEqual(
      [
        'auction_discounted_fee',
        'auction_expiration',
        'auction_holder',
        'auction_price',
        'lp_currency',
        'lp_supply',
        'reserve_base',
        'reserve_counter',
        'trading_fee',
      ].sort(),
    );
    expect(Object.keys(EMPTY_FILL).sort()).toEqual([...FILLED_COLUMNS].sort());
    expect(Object.values(EMPTY_FILL).every((v) => v === null)).toBe(true);
  });
});

describe('the marker of the list of pools', () => {
  it('is the value and the account of the last pool of the page, as base64url JSON', () => {
    expect(JSON.parse(Buffer.from(encodePoolsMarker(28110514.1946255, 'rPool'), 'base64url').toString('utf8'))).toEqual(
      [28110514.1946255, 'rPool'],
    );
    expect(JSON.parse(Buffer.from(encodePoolsMarker(null, 'rPool'), 'base64url').toString('utf8'))).toEqual([
      null,
      'rPool',
    ]);
  });

  it('round-trips a value exactly, whatever its digits, and a pool without a value', () => {
    for (const value of [0, 1, 0.1 + 0.2, 28110514.1946255, 1e21, 5e-324, 123456789.12345679, null]) {
      expect(decodePoolsMarker(encodePoolsMarker(value, 'rA'))).toEqual([value, 'rA']);
    }
  });

  it('no marker is the first page', () => {
    expect(decodePoolsMarker(undefined)).toBeUndefined();
    expect(decodePoolsMarker('')).toBeUndefined();
  });

  it('anything that is not a marker of this list is 400 invalid marker', () => {
    const bad = [
      '!!!',
      Buffer.from('not json').toString('base64url'),
      encodeMarker([1]),
      encodeMarker([1, 'rA', 3]),
      encodeMarker(['1', 'rA']),
      encodeMarker([1, 2]),
      Buffer.from(JSON.stringify([null, 7])).toString('base64url'),
      Buffer.from(JSON.stringify({ a: 1 })).toString('base64url'),
      Buffer.from('[1e999,"rA"]').toString('base64url'),
      Buffer.from('[true,"rA"]').toString('base64url'),
    ];
    for (const marker of bad) {
      let caught: unknown;
      try {
        decodePoolsMarker(marker);
      } catch (err) {
        caught = err;
      }
      expect([marker, caught instanceof RippleHttpError, (caught as RippleHttpError)?.getStatus()]).toEqual([
        marker,
        true,
        400,
      ]);
      expect((caught as RippleHttpError).getResponse()).toEqual({ result: 'error', message: 'invalid marker' });
    }
  });
});

describe('poolsKeyset', () => {
  it('the first page has no condition', () => {
    expect(poolsKeyset(undefined)).toEqual({ clause: '', params: {} });
  });

  it('after a pool with a value: a lower value, the same value and a later account, or no value at all', () => {
    const { clause, params } = poolsKeyset([12.5, 'rPool']);
    expect(params).toEqual({ after_value: 12.5, after_account: 'rPool' });
    expect(clause).toBe(
      '(value_native < {after_value:Float64} OR (value_native = {after_value:Float64} AND amm_account > {after_account:String}) OR value_native IS NULL)',
    );
  });

  it('after a pool without a value: only the pools without one, with a later account', () => {
    const { clause, params } = poolsKeyset([null, 'rPool']);
    expect(params).toEqual({ after_account: 'rPool' });
    expect(clause).toBe('(value_native IS NULL AND amm_account > {after_account:String})');
  });
});
