import { RippleHttpError } from '../common/errors';
import { parseLedgerIdentifier } from './ledger-identifier';

/** Runs `fn` and returns the Ripple error it must throw, as a `[status, message]` pair. */
function thrown(fn: () => unknown): [number, string] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RippleHttpError);
    const err = e as RippleHttpError;
    return [err.getStatus(), (err.getResponse() as { message: string }).message];
  }
  throw new Error('expected the call to throw');
}

const HASH = 'B5931AD267E59306769309AFF13FCCD55C2EF944E99228C8F2EEEC5D3B49234D';

describe('parseLedgerIdentifier', () => {
  describe('no identifier', () => {
    it('is the latest ledger: nothing is selected', () => {
      expect(parseLedgerIdentifier(undefined, {})).toEqual({});
      expect(parseLedgerIdentifier('', {})).toEqual({});
    });

    it('ignores empty alternatives and unknown parameters', () => {
      expect(parseLedgerIdentifier(undefined, { ledger_index: '', ledger_hash: '', date: '', foo: 'bar' })).toEqual({});
    });
  });

  describe('the path identifier', () => {
    it('digits are a ledger index', () => {
      expect(parseLedgerIdentifier('11119599', {})).toEqual({ index: 11119599 });
      expect(parseLedgerIdentifier('0', {})).toEqual({ index: 0 });
    });

    it('2015 is a ledger index, not a year', () => {
      expect(parseLedgerIdentifier('2015', {})).toEqual({ index: 2015 });
    });

    it('digits win over the date formats made of digits (YYYYMMDDHHmmss, 10 digit unix seconds)', () => {
      expect(parseLedgerIdentifier('20150114174310', {})).toEqual({ index: 20150114174310 });
      expect(parseLedgerIdentifier('1421257390', {})).toEqual({ index: 1421257390 });
    });

    it('even-length hex is a ledger hash, in upper case', () => {
      expect(parseLedgerIdentifier(HASH.toLowerCase(), {})).toEqual({ hash: HASH });
      expect(parseLedgerIdentifier(HASH, {})).toEqual({ hash: HASH });
      expect(parseLedgerIdentifier('ab', {})).toEqual({ hash: 'AB' });
      expect(parseLedgerIdentifier('1a', {})).toEqual({ hash: '1A' });
    });

    it('keeps the 0x prefix the hex test of Ripple accepts (the hash then matches no ledger)', () => {
      expect(parseLedgerIdentifier('0xab', {})).toEqual({ hash: '0XAB' });
    });

    it('a date is "closed at or before the end of the period it names"', () => {
      // lib/hbase/hbase-thrift/data.js scans lu_ledgers_by_time up to smoment.hbaseFormatStopRow(): one unit of the
      // granularity of the text on. `date` is the last instant of that period.
      const iso = (id: { date?: Date }) => id.date?.toISOString();
      expect(iso(parseLedgerIdentifier('2015-01-14T17:43:10', {}))).toBe('2015-01-14T17:43:10.999Z');
      expect(iso(parseLedgerIdentifier('2015-01-14T17:43:10Z', {}))).toBe('2015-01-14T17:43:10.999Z');
      expect(iso(parseLedgerIdentifier('2015-01-14T17:43:10+01:00', {}))).toBe('2015-01-14T16:43:10.999Z');
      expect(iso(parseLedgerIdentifier('2015-01-14T17:43', {}))).toBe('2015-01-14T17:43:59.999Z');
      expect(iso(parseLedgerIdentifier('2015-01-14T17', {}))).toBe('2015-01-14T17:59:59.999Z');
      expect(iso(parseLedgerIdentifier('2015-01-14', {}))).toBe('2015-01-14T23:59:59.999Z');
      expect(iso(parseLedgerIdentifier('2015-02', {}))).toBe('2015-02-28T23:59:59.999Z');
      expect(iso(parseLedgerIdentifier('2015-01-14T17:43:10.500Z', {}))).toBe('2015-01-14T17:43:10.500Z');
    });

    it.each(['b59', 'abc', 'xyz', 'zz', '2015-13-45', '2015-01-14T25:00:00', '0x', 'b5931ad267e5930', '12ab-', 'null'])(
      '%j is 400 invalid ledger identifier (odd-length hex, not hex, not a date)',
      (param) => {
        expect(thrown(() => parseLedgerIdentifier(param, {}))).toEqual([400, 'invalid ledger identifier']);
      },
    );

    it('is not validated against the query alternatives when it is invalid', () => {
      expect(thrown(() => parseLedgerIdentifier('b59', { ledger_index: '5' }))).toEqual([
        400,
        'invalid ledger identifier',
      ]);
    });
  });

  describe('the query alternatives', () => {
    it('ledger_index', () => {
      expect(parseLedgerIdentifier(undefined, { ledger_index: '11119599' })).toEqual({ index: 11119599 });
    });

    it('ledger_hash, in upper case', () => {
      expect(parseLedgerIdentifier(undefined, { ledger_hash: HASH.toLowerCase() })).toEqual({ hash: HASH });
    });

    it('a ledger_hash is not validated: whatever is not a ledger hash finds no ledger', () => {
      expect(parseLedgerIdentifier(undefined, { ledger_hash: 'xyz' })).toEqual({ hash: 'XYZ' });
    });

    it('date', () => {
      const id = parseLedgerIdentifier(undefined, { date: '2015-01-14T17:43:10' });
      expect(id.date?.toISOString()).toBe('2015-01-14T17:43:10.999Z');
      expect(id.index).toBeUndefined();
      expect(id.hash).toBeUndefined();
    });

    it('an invalid date is 400 invalid date format', () => {
      expect(thrown(() => parseLedgerIdentifier(undefined, { date: 'yesterday' }))).toEqual([
        400,
        'invalid date format',
      ]);
      expect(thrown(() => parseLedgerIdentifier(undefined, { date: '2015-02-30' }))).toEqual([
        400,
        'invalid date format',
      ]);
    });

    it('the date is not read when the path has an identifier', () => {
      expect(parseLedgerIdentifier('5', { date: 'yesterday' })).toEqual({ index: 5 });
    });

    it('a ledger_index that is not a whole number finds no ledger (404, as the empty key range of Ripple)', () => {
      for (const bad of ['abc', '-5', '1.5', '1e3', ' 5', '0x10']) {
        expect(thrown(() => parseLedgerIdentifier(undefined, { ledger_index: bad }))).toEqual([
          404,
          'ledger not found',
        ]);
      }
    });

    it('a repeated parameter counts with its first value', () => {
      expect(parseLedgerIdentifier(undefined, { ledger_index: ['7', '8'] })).toEqual({ index: 7 });
      expect(parseLedgerIdentifier(undefined, { ledger_hash: ['ab', 'cd'] })).toEqual({ hash: 'AB' });
    });
  });

  describe('which identifier wins (getLedger.js: path over query, then hash, then date, then index)', () => {
    it('a path index replaces the query ledger_index', () => {
      expect(parseLedgerIdentifier('5', { ledger_index: '9' })).toEqual({ index: 5 });
    });

    it('a path hash replaces the query ledger_hash', () => {
      expect(parseLedgerIdentifier('ab', { ledger_hash: 'cd' })).toEqual({ hash: 'AB' });
    });

    it('a query ledger_hash beats a path index and a path date', () => {
      expect(parseLedgerIdentifier('5', { ledger_hash: 'ab' })).toEqual({ hash: 'AB' });
      expect(parseLedgerIdentifier('2015-01-14', { ledger_hash: 'ab' })).toEqual({ hash: 'AB' });
    });

    it('a date beats a query ledger_index, and a query ledger_hash beats both', () => {
      const dated = parseLedgerIdentifier(undefined, { date: '2015-01-14', ledger_index: '5' });
      expect(dated.date?.toISOString()).toBe('2015-01-14T23:59:59.999Z');
      expect(dated.index).toBeUndefined();
      expect(parseLedgerIdentifier(undefined, { date: '2015-01-14', ledger_index: '5', ledger_hash: 'ab' })).toEqual({
        hash: 'AB',
      });
    });

    it('a ledger_hash hides a ledger_index that is garbage', () => {
      expect(parseLedgerIdentifier(undefined, { ledger_hash: 'ab', ledger_index: 'abc' })).toEqual({ hash: 'AB' });
    });
  });
});
