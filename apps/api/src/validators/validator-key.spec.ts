import { encodeAccountPublic, encodeNodePublic } from 'ripple-address-codec';
import type { Directory, DirectoryEntry } from './directory';
import { parseValidatorKey, resolveValidator } from './validator-key';

/** A node public key of 33 bytes: the prefix byte and 32 more. */
const base58 = (prefix: string, byte: string): string => encodeNodePublic(Buffer.from(prefix + byte.repeat(32), 'hex'));

const MASTER = base58('ED', '2a');
const SIGNING = base58('03', '5b');

function expectBadKey(raw: string): void {
  expect(() => parseValidatorKey(raw)).toThrow(expect.objectContaining({ status: 400 }));
  try {
    parseValidatorKey(raw);
  } catch (err) {
    expect((err as { getResponse(): unknown }).getResponse()).toEqual({
      result: 'error',
      message: 'invalid validator public key',
    });
  }
}

describe('parseValidatorKey', () => {
  it('takes a master key and a signing key as they are', () => {
    expect(MASTER.startsWith('nH')).toBe(true);
    expect(SIGNING.startsWith('n9')).toBe(true);
    expect(parseValidatorKey(MASTER)).toBe(MASTER);
    expect(parseValidatorKey(SIGNING)).toBe(SIGNING);
  });

  it.each([
    ['ED', 'ed25519'],
    ['02', 'secp256k1, even y'],
    ['03', 'secp256k1, odd y'],
  ])('turns 66 hex digits starting %s (%s) into the base58 key, in either case', (prefix) => {
    const hex = `${prefix}${'9C'.repeat(32)}`;
    const expected = encodeNodePublic(Buffer.from(hex, 'hex'));
    expect(parseValidatorKey(hex.toUpperCase())).toBe(expected);
    expect(parseValidatorKey(hex.toLowerCase())).toBe(expected);
    // a mixed case is hex all the same
    expect(parseValidatorKey(`${hex.slice(0, 20).toLowerCase()}${hex.slice(20).toUpperCase()}`)).toBe(expected);
  });

  it('turns the hex of a real master key into its nH key', () => {
    const hex = 'ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734';
    expect(parseValidatorKey(hex)).toBe(encodeNodePublic(Buffer.from(hex, 'hex')));
    expect(parseValidatorKey(hex).startsWith('nH')).toBe(true);
  });

  it('answers 400 invalid validator public key for a key type that is not one', () => {
    expectBadKey(`04${'9C'.repeat(32)}`);
    expectBadKey(`EE${'9C'.repeat(32)}`);
    expectBadKey(`00${'9C'.repeat(32)}`);
  });

  it('answers 400 for hex of the wrong length (64 and 68 digits, and an odd count)', () => {
    expectBadKey('ED' + '9C'.repeat(31)); // 64
    expectBadKey('ED' + '9C'.repeat(33)); // 68
    expectBadKey('ED' + '9C'.repeat(32) + 'A'); // 67
    expectBadKey('ED' + '9C'.repeat(32).slice(1)); // 65
  });

  it('answers 400 for hex that is not hex', () => {
    expectBadKey('ED' + 'ZZ'.repeat(32));
    expectBadKey(` ED${'9C'.repeat(32)}`);
    expectBadKey(`0x${'9C'.repeat(32)}`);
  });

  it('answers 400 for a classic address, a word, an empty text and a key with a wrong checksum', () => {
    expectBadKey('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
    expectBadKey('summary');
    expectBadKey('manifests');
    expectBadKey('');
    expectBadKey(`${MASTER.slice(0, -1)}${MASTER.endsWith('a') ? 'b' : 'a'}`);
    expectBadKey(MASTER.slice(0, -4));
  });

  it('answers 400 for a base58 key of another kind (an account public key)', () => {
    // an account public key ("aB...") has the length of a node key and a good checksum, but another version byte
    const account = encodeAccountPublic(Buffer.from(`ED${'2a'.repeat(32)}`, 'hex'));
    expect(account.startsWith('a')).toBe(true);
    expectBadKey(account);
  });
});

describe('resolveValidator', () => {
  const entry = (key: string): DirectoryEntry =>
    ({
      key,
      agreement1h: {},
      agreement24h: {},
      agreement30d: {},
      daily: [],
      unlLists: [],
    }) as unknown as DirectoryEntry;
  const MASTER_ENTRY = entry(MASTER);
  const directory = {
    entries: new Map([[MASTER, MASTER_ENTRY]]),
    signingToMaster: new Map([
      [SIGNING, MASTER],
      ['n9GhostSigning', 'nHGhostMaster'],
    ]),
  } as unknown as Directory;

  it('finds a master key', () => {
    expect(resolveValidator(directory, MASTER)).toBe(MASTER_ENTRY);
  });

  it('finds the master of a signing key through the manifest map', () => {
    expect(resolveValidator(directory, SIGNING)).toBe(MASTER_ENTRY);
  });

  it('answers 404 Validator not found for a key the directory does not know', () => {
    const unknown = base58('ED', '77');
    expect(() => resolveValidator(directory, unknown)).toThrow(expect.objectContaining({ status: 404 }));
    try {
      resolveValidator(directory, unknown);
    } catch (err) {
      expect((err as { getResponse(): unknown }).getResponse()).toEqual({
        result: 'error',
        message: 'Validator not found',
      });
    }
  });

  it('answers 404 for a signing key whose master has no entry', () => {
    expect(() => resolveValidator(directory, 'n9GhostSigning')).toThrow(expect.objectContaining({ status: 404 }));
  });
});
