import { RippleHttpError } from '../common/errors';
import { decodeMptHoldersMarker, parseIdsParam, parseIssuanceIdParam, parseKindsParam } from './mpt-param';

const ID = '0000012A9AB7E5A9F3DE1D7F1E8B2C4D5F6A7B8C9D0E1F20';

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

describe('parseIssuanceIdParam', () => {
  it('takes 48 hex digits in either case and answers them in upper case', () => {
    expect(parseIssuanceIdParam(ID)).toBe(ID);
    expect(parseIssuanceIdParam(ID.toLowerCase())).toBe(ID);
  });

  it.each([
    ['47 digits', ID.slice(0, 47)],
    ['49 digits', `${ID}0`],
    ['a 0x prefix', `0x${ID.slice(0, 46)}`],
    ['a 0x prefix on 48 digits', `0x${ID}`],
    ['a letter past F', `${ID.slice(0, 47)}G`],
    ['nothing', ''],
    ['a line end', `${ID}\n`],
  ])('refuses %s', (_name, raw) => {
    expect(badRequestMessage(() => parseIssuanceIdParam(raw))).toBe('invalid mpt issuance id');
  });
});

describe('parseIdsParam', () => {
  const OTHER = `0000012B${ID.slice(8)}`;

  it('reads the list, upper-cased, in request order, duplicates too', () => {
    expect(parseIdsParam({ ids: `${OTHER.toLowerCase()},${ID},${OTHER}` })).toEqual([OTHER, ID, OTHER]);
    expect(parseIdsParam({ ids: ID })).toEqual([ID]);
    expect(parseIdsParam({ ids: Array(100).fill(ID).join(',') })).toHaveLength(100);
  });

  it('refuses ids in order', () => {
    // nothing at all
    expect(badRequestMessage(() => parseIdsParam({}))).toBe('ids is required');
    expect(badRequestMessage(() => parseIdsParam({ ids: '' }))).toBe('ids is required');
    // too many comes before a bad one
    expect(badRequestMessage(() => parseIdsParam({ ids: Array(101).fill(ID).join(',') }))).toBe('too many ids');
    expect(badRequestMessage(() => parseIdsParam({ ids: [...Array(100).fill(ID), 'bad'].join(',') }))).toBe(
      'too many ids',
    );
    // an empty element is a bad one
    expect(badRequestMessage(() => parseIdsParam({ ids: `${ID},,${OTHER}` }))).toBe('invalid mpt issuance id');
    expect(badRequestMessage(() => parseIdsParam({ ids: `${ID},` }))).toBe('invalid mpt issuance id');
    expect(badRequestMessage(() => parseIdsParam({ ids: ',' }))).toBe('invalid mpt issuance id');
    expect(badRequestMessage(() => parseIdsParam({ ids: `${ID},${ID.slice(0, 47)}` }))).toBe('invalid mpt issuance id');
  });
});

describe('parseKindsParam', () => {
  const MESSAGE = 'invalid kind - use: payment, clawback, lock, unlock, escrow_create, escrow_finish, escrow_cancel';

  it('reads a comma list in order, without repeats; missing or empty is none', () => {
    expect(parseKindsParam({})).toBeUndefined();
    expect(parseKindsParam({ kind: '' })).toBeUndefined();
    expect(parseKindsParam({ kind: 'lock,unlock,lock' })).toEqual(['lock', 'unlock']);
    expect(parseKindsParam({ kind: 'escrow_cancel' })).toEqual(['escrow_cancel']);
  });

  it.each(['mint', 'lock,mint', 'lock,', ',lock', 'LOCK'])('refuses %j', (kind) => {
    expect(badRequestMessage(() => parseKindsParam({ kind }))).toBe(MESSAGE);
  });
});

describe('decodeMptHoldersMarker', () => {
  const marker = (values: unknown[]): string => Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');

  it('reads the balance as text, the largest too', () => {
    expect(decodeMptHoldersMarker(undefined)).toBeUndefined();
    expect(decodeMptHoldersMarker('')).toBeUndefined();
    expect(decodeMptHoldersMarker(marker(['9007199254740993', 'rA']))).toEqual(['9007199254740993', 'rA']);
    expect(decodeMptHoldersMarker(marker(['9223372036854775807', 'rA']))).toEqual(['9223372036854775807', 'rA']);
    expect(decodeMptHoldersMarker(marker(['0', '']))).toEqual(['0', '']);
  });

  it.each([
    ['a number', [5, 'rA']],
    ['not digits', ['5x', 'rA']],
    ['a sign', ['-5', 'rA']],
    ['20 digits', ['10000000000000000000', 'rA']],
    ['above 2^63 - 1', ['9223372036854775808', 'rA']],
    ['one value', ['5']],
    ['no holder', ['5', 7]],
  ])('refuses %s', (_name, values) => {
    expect(badRequestMessage(() => decodeMptHoldersMarker(marker(values)))).toBe('invalid marker');
  });
});
