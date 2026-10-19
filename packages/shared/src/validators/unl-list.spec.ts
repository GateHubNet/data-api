import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getNetworkProfile, parseUnlPublishers } from '../network';
import { makeManifest, makeUnlBlob, makeUnlResponse, TestKey, testKey } from '../test-utils/validator-keys';
import { decodeManifest, Manifest, REVOKED_SEQUENCE } from './manifest';
import { nodePublicKeyFromHex } from './node-key';
import { classifyUnlBlob, UnlBlob, UnlFailure, UnlListError, verifyUnlList } from './unl-list';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const RIPPLE_EPOCH = 946_684_800;

type Body = Record<string, unknown>;

function load(file: string): Body {
  return JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Body;
}

/** The configured key of a default publisher of a network profile. */
function configuredKey(network: 'xrpl' | 'xahau', id: string): string {
  const publisher = parseUnlPublishers(getNetworkProfile(network).defaultUnlPublishers).find((p) => p.id === id);
  if (!publisher) throw new Error(`no default publisher ${id} for ${network}`);
  return publisher.publicKey;
}

const hexOf = (base64: string) => Buffer.from(base64, 'base64').toString('hex').toUpperCase();
const base64Of = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** `hex` with the byte at `at` (negative: from the end) XOR-ed with 0x01. */
function flipByte(hex: string, at: number): string {
  const index = (at < 0 ? hex.length / 2 + at : at) * 2;
  const byte = parseInt(hex.slice(index, index + 2), 16) ^ 0x01;
  return hex.slice(0, index) + byte.toString(16).padStart(2, '0').toUpperCase() + hex.slice(index + 2);
}

/** The failure reason of a verification, or `undefined` when the list verified. */
function failureOf(body: unknown, key: string, known?: Manifest): UnlFailure | undefined {
  try {
    verifyUnlList(body, key, known);
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(UnlListError);
    return (err as UnlListError).reason;
  }
}

const RECORDED = [
  {
    network: 'xrpl' as const,
    id: 'vl.ripple.com',
    file: 'xrpl/unl/vl.ripple.com.json',
    // F14 on 2026-10-19 (the values the planner saw); the recording of the same day gave the same ones.
    sequence: 85,
    validators: 35,
    expiration: '2027-04-06T17:51:34.000Z',
  },
  {
    network: 'xrpl' as const,
    id: 'unl.xrplf.org',
    file: 'xrpl/unl/unl.xrplf.org.json',
    sequence: 2026070302,
    validators: 35,
    expiration: '2027-07-03T00:00:00.000Z',
  },
  {
    network: 'xahau' as const,
    id: 'vl.xahau.org',
    file: 'xahau/unl/vl.xahau.org.json',
    sequence: 2026092401,
    validators: 19,
    expiration: '2027-09-25T00:00:00.000Z',
  },
];

describe('verifyUnlList on the recorded lists', () => {
  it.each(RECORDED)('$id verifies with the key of its network profile', (recorded) => {
    const body = load(recorded.file);
    const key = configuredKey(recorded.network, recorded.id);
    const list = verifyUnlList(body, key);

    expect(list.version).toBe(1);
    expect(list.publisherKey).toBe(key);
    expect(list.manifest.masterKeyHex).toBe(key);
    expect(list.manifest.revoked).toBe(false);
    expect(list.refreshIntervalMinutes).toBeUndefined();
    expect(list.blobs).toHaveLength(1);

    const [blob] = list.blobs;
    expect(blob.sequence).toBe(recorded.sequence);
    expect(blob.validators).toHaveLength(recorded.validators);
    expect(new Date(blob.expiration * 1000).toISOString()).toBe(recorded.expiration);
    expect(blob.effective).toBeUndefined();
    expect(blob.blobSha256).toBe(sha256Of(Buffer.from(body.blob as string, 'base64')));
  });

  it('reads the validators of a recorded blob: base58 master key and the raw base64 manifest', () => {
    const body = load('xahau/unl/vl.xahau.org.json');
    const raw = JSON.parse(Buffer.from(body.blob as string, 'base64').toString('utf8')) as {
      validators: { validation_public_key: string; manifest: string }[];
    };
    const [blob] = verifyUnlList(body, configuredKey('xahau', 'vl.xahau.org')).blobs;
    expect(blob.validators).toEqual(
      raw.validators.map((v) => ({
        masterKey: nodePublicKeyFromHex(v.validation_public_key),
        manifest: v.manifest,
      })),
    );
    expect(blob.validators[0].masterKey).toMatch(/^nH/);
    // Each validator manifest names the master key of its entry.
    for (const validator of blob.validators) {
      expect(decodeManifest(validator.manifest as string, 'base64').masterKey).toBe(validator.masterKey);
    }
  });

  it('takes the configured key in any case and answers it in upper case', () => {
    const body = load('xrpl/unl/vl.ripple.com.json');
    const key = configuredKey('xrpl', 'vl.ripple.com');
    expect(verifyUnlList(body, key.toLowerCase()).publisherKey).toBe(key);
    const lowered = { ...body, public_key: (body.public_key as string).toLowerCase() };
    expect(verifyUnlList(lowered, key).publisherKey).toBe(key);
  });

  it.each(RECORDED)('$id verifies with its own manifest as the known one, too, and answers it', (recorded) => {
    const body = load(recorded.file);
    const key = configuredKey(recorded.network, recorded.id);
    const own = decodeManifest(body.manifest as string, 'base64');
    const without = verifyUnlList(body, key);
    const withKnown = verifyUnlList(body, key, own);
    expect(withKnown).toEqual(without);
    expect(withKnown.manifest).toEqual(own);
  });

  it('takes the body as JSON text, too', () => {
    const body = load('xrpl/unl/vl.ripple.com.json');
    expect(verifyUnlList(JSON.stringify(body), configuredKey('xrpl', 'vl.ripple.com')).blobs).toHaveLength(1);
  });

  it('does not change the body it is given', () => {
    const body = load('xrpl/unl/unl.xrplf.org.json');
    const before = JSON.stringify(body);
    verifyUnlList(body, configuredKey('xrpl', 'unl.xrplf.org'));
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe('verifyUnlList refuses a recorded list that was changed', () => {
  const ripple = configuredKey('xrpl', 'vl.ripple.com');
  const xrplf = configuredKey('xrpl', 'unl.xrplf.org');
  const real = (): Body => clone(load('xrpl/unl/vl.ripple.com.json'));

  it('untrusted_key: another configured key', () => {
    expect(failureOf(real(), xrplf)).toBe('untrusted_key');
    expect(failureOf(real(), configuredKey('xahau', 'vl.xahau.org'))).toBe('untrusted_key');
    expect(failureOf(real(), 'ED' + '00'.repeat(32))).toBe('untrusted_key');
  });

  it('untrusted_key: the body names another key than the configured one', () => {
    const body = real();
    body.public_key = xrplf;
    expect(failureOf(body, ripple)).toBe('untrusted_key');
  });

  it('invalid_format: a public_key that is not 66 ASCII hex digits, even if it upper-cases to the configured key', () => {
    // 'ﬀ' (U+FB00) upper-cases to 'FF', and this key has one: toUpperCase alone would take the body for the configured key.
    expect(ripple).toContain('FF');
    for (const publicKey of [
      ripple.replace('FF', '\uFB00'),
      ripple.slice(0, 64),
      ripple + '00',
      ' ' + ripple,
      ripple + '\n',
      '0x' + ripple.slice(2),
      ripple.replace('AB', 'ab\u0000'),
    ]) {
      const body = real();
      body.public_key = publicKey;
      expect(failureOf(body, ripple)).toBe('invalid_format');
    }
    const lowered = real();
    lowered.public_key = ripple.toLowerCase();
    expect(failureOf(lowered, ripple)).toBeUndefined();
  });

  it('manifest_invalid: a byte of the publisher manifest signature', () => {
    const body = real();
    // The master signature closes the canonical encoding of a manifest.
    body.manifest = base64Of(flipByte(hexOf(body.manifest as string), -10));
    expect(failureOf(body, ripple)).toBe('manifest_invalid');
  });

  it('manifest_invalid: a byte of the publisher manifest sequence', () => {
    const body = real();
    body.manifest = base64Of(flipByte(hexOf(body.manifest as string), 4));
    expect(failureOf(body, ripple)).toBe('manifest_invalid');
  });

  it('manifest_invalid: the manifest of another publisher', () => {
    const body = real();
    body.manifest = load('xrpl/unl/unl.xrplf.org.json').manifest;
    expect(failureOf(body, ripple)).toBe('manifest_invalid');
  });

  it('manifest_invalid: a manifest that does not decode', () => {
    for (const manifest of [
      '',
      '!!!!',
      base64Of('00'),
      (load('xrpl/unl/vl.ripple.com.json').manifest as string).slice(0, -8),
    ]) {
      const body = real();
      body.manifest = manifest;
      expect(failureOf(body, ripple)).toBe('manifest_invalid');
    }
  });

  it('signature_invalid: a byte of the blob signature', () => {
    const body = real();
    body.signature = flipByte(body.signature as string, 10);
    expect(failureOf(body, ripple)).toBe('signature_invalid');
  });

  it('signature_invalid: a changed blob under the signature of the original', () => {
    const body = real();
    const blob = JSON.parse(Buffer.from(body.blob as string, 'base64').toString('utf8')) as { sequence: number };
    blob.sequence += 1;
    body.blob = Buffer.from(JSON.stringify(blob)).toString('base64');
    expect(failureOf(body, ripple)).toBe('signature_invalid');
  });

  it('signature_invalid: the signature of another publisher, a signature that is not hex, a missing one', () => {
    const swapped = real();
    swapped.signature = load('xrpl/unl/unl.xrplf.org.json').signature;
    expect(failureOf(swapped, ripple)).toBe('signature_invalid');

    for (const signature of [
      '',
      'xyz',
      (real().signature as string).slice(0, -2),
      (real().signature as string) + '00',
    ]) {
      const body = real();
      body.signature = signature;
      expect(failureOf(body, ripple)).toBe('signature_invalid');
    }
  });
});

describe('verifyUnlList on test-signed lists', () => {
  const NOW = 1_800_000_000;
  const publisher = testKey('unl-publisher');
  const signing = testKey('unl-publisher-signing', 'ecdsa-secp256k1');
  const alpha = testKey('unl-alpha');
  const beta = testKey('unl-beta', 'ecdsa-secp256k1');

  const goodBlob = () =>
    makeUnlBlob({ sequence: 7, expiration: NOW + 3600, validators: [{ master: alpha }, { master: beta }] });
  /** A blob built from raw JSON, to put in what a publisher signs. */
  const rawBlob = (json: unknown) =>
    Buffer.from(typeof json === 'string' ? json : JSON.stringify(json)).toString('base64');
  const valid = (overrides: Body = {}): Body => ({
    sequence: 7,
    expiration: NOW + 3600 - RIPPLE_EPOCH,
    validators: [{ validation_public_key: alpha.publicKeyHex }],
    ...overrides,
  });
  const list1 = (blob: string, extra: Partial<Parameters<typeof makeUnlResponse>[0]> = {}) =>
    makeUnlResponse({ publisher, publisherSigning: signing, blobs: [{ blob }], ...extra });
  const blobFailure = (blob: string) => failureOf(list1(blob), publisher.publicKeyHex);

  it('verifies a version 1 list of an ed25519 publisher with a secp256k1 signing key', () => {
    const body = list1(goodBlob());
    expect(body.version).toBe(1);
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(['public_key', 'manifest', 'blob', 'signature', 'version']),
    );
    const list = verifyUnlList(body, publisher.publicKeyHex);
    expect(list.version).toBe(1);
    expect(list.publisherKey).toBe(publisher.publicKeyHex);
    expect(list.manifest).toMatchObject({ masterKey: publisher.base58, signingKey: signing.base58, sequence: 1 });
    expect(list.blobs).toEqual([
      {
        sequence: 7,
        expiration: NOW + 3600,
        blobSha256: sha256Of(Buffer.from(body.blob as string, 'base64')),
        validators: [{ masterKey: alpha.base58 }, { masterKey: beta.base58 }],
      },
    ]);
  });

  it('verifies a publisher with a secp256k1 master key and an ed25519 signing key', () => {
    const ecdsa = testKey('unl-ecdsa-publisher', 'ecdsa-secp256k1');
    const body = makeUnlResponse({
      publisher: ecdsa,
      publisherSigning: testKey('unl-ed-signing'),
      blobs: [{ blob: goodBlob() }],
    });
    expect(verifyUnlList(body, ecdsa.publicKeyHex).blobs).toHaveLength(1);
  });

  it('turns the Ripple-epoch times of a blob into unix seconds', () => {
    const blob = makeUnlBlob({
      sequence: 1,
      effective: NOW - 100,
      expiration: NOW + 100,
      validators: [{ master: alpha }],
    });
    const raw = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as { effective: number; expiration: number };
    expect(raw).toMatchObject({ effective: NOW - 100 - RIPPLE_EPOCH, expiration: NOW + 100 - RIPPLE_EPOCH });
    const [read] = verifyUnlList(list1(blob), publisher.publicKeyHex).blobs;
    expect(read).toMatchObject({ effective: NOW - 100, expiration: NOW + 100 });
  });

  it('keeps the manifest of a validator, as given', () => {
    const manifestHex = makeManifest({
      master: alpha,
      signing: testKey('unl-alpha-signing'),
      sequence: 2,
      domain: 'alpha.example',
    });
    const blob = makeUnlBlob({
      sequence: 1,
      expiration: NOW + 1,
      validators: [{ master: alpha, manifestHex }, { master: beta }],
    });
    const [read] = verifyUnlList(list1(blob), publisher.publicKeyHex).blobs;
    expect(read.validators).toEqual([
      { masterKey: alpha.base58, manifest: base64Of(manifestHex) },
      { masterKey: beta.base58 },
    ]);
  });

  it('accepts a blob without validators', () => {
    const [read] = verifyUnlList(list1(rawBlob(valid({ validators: [] }))), publisher.publicKeyHex).blobs;
    expect(read.validators).toEqual([]);
  });

  describe('refresh_interval', () => {
    it('is read from the body, in minutes, as it is', () => {
      expect(
        verifyUnlList(list1(goodBlob(), { refreshInterval: 15 }), publisher.publicKeyHex).refreshIntervalMinutes,
      ).toBe(15);
      expect(
        verifyUnlList(list1(goodBlob(), { refreshInterval: 100000 }), publisher.publicKeyHex).refreshIntervalMinutes,
      ).toBe(100000);
    });

    it('is left out when the body has none or not a number', () => {
      expect(verifyUnlList(list1(goodBlob()), publisher.publicKeyHex).refreshIntervalMinutes).toBeUndefined();
      const body = list1(goodBlob());
      body.refresh_interval = '15';
      expect(verifyUnlList(body, publisher.publicKeyHex).refreshIntervalMinutes).toBeUndefined();
    });
  });

  describe('invalid_format', () => {
    const ok = () => list1(goodBlob());
    const without = (field: string) => {
      const body = ok();
      delete body[field];
      return body;
    };

    it('is the answer to a body that is not an object with the three fields', () => {
      for (const body of [null, undefined, 7, true, [], [ok()], '', 'not json', '"text"', '{', 'null']) {
        expect(failureOf(body, publisher.publicKeyHex)).toBe('invalid_format');
      }
      for (const field of ['public_key', 'manifest', 'version', 'blob', 'signature']) {
        expect(failureOf(without(field), publisher.publicKeyHex)).toBe('invalid_format');
      }
    });

    it('is the answer to fields of the wrong type', () => {
      for (const [field, value] of [
        ['public_key', 1],
        ['manifest', null],
        ['version', '1'],
        ['version', 1.5],
        ['version', null],
        ['blob', 5],
        ['signature', ['00']],
      ] as [string, unknown][]) {
        const body = ok();
        body[field] = value;
        expect(failureOf(body, publisher.publicKeyHex)).toBe('invalid_format');
      }
    });

    it('is the answer to a version 1 list that also has blobs_v2', () => {
      const body = ok();
      body.blobs_v2 = [];
      expect(failureOf(body, publisher.publicKeyHex)).toBe('invalid_format');
      body.blobs_v2 = [{ blob: body.blob, signature: body.signature }];
      expect(failureOf(body, publisher.publicKeyHex)).toBe('invalid_format');
    });

    it('is the answer to a version 2 list that also has blob or signature', () => {
      for (const extra of [{ blob: goodBlob() }, { signature: 'AB' }, { blob: goodBlob(), signature: 'AB' }]) {
        const body = { ...list1(goodBlob(), { version: 2 }), ...extra };
        expect(failureOf(body, publisher.publicKeyHex)).toBe('invalid_format');
      }
    });

    it('is the answer to a version 2 list with no blobs_v2, an empty one, one that is not an array, or more than 5 entries', () => {
      const v2 = () => list1(goodBlob(), { version: 2 });
      const missing = v2();
      delete missing.blobs_v2;
      expect(failureOf(missing, publisher.publicKeyHex)).toBe('invalid_format');
      expect(failureOf({ ...v2(), blobs_v2: [] }, publisher.publicKeyHex)).toBe('invalid_format');
      expect(failureOf({ ...v2(), blobs_v2: {} }, publisher.publicKeyHex)).toBe('invalid_format');
      expect(failureOf({ ...v2(), blobs_v2: 'x' }, publisher.publicKeyHex)).toBe('invalid_format');
    });

    it('is the answer to a version 2 list of 6 blobs, and not to one of 5', () => {
      const blobs = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          blob: makeUnlBlob({ sequence: 10 + i, expiration: NOW + 3600, validators: [{ master: alpha }] }),
        }));
      const five = makeUnlResponse({ publisher, publisherSigning: signing, version: 2, blobs: blobs(5) });
      const six = makeUnlResponse({ publisher, publisherSigning: signing, version: 2, blobs: blobs(6) });
      expect(six.blobs_v2).toHaveLength(6);
      expect(failureOf(six, publisher.publicKeyHex)).toBe('invalid_format');
      expect(failureOf(five, publisher.publicKeyHex)).toBeUndefined();
    });

    it('is the answer to a version 2 entry that is malformed', () => {
      const entry = () => ({ blob: goodBlob(), signature: 'AB' });
      const v2 = (blobs_v2: unknown) => ({ ...list1(goodBlob(), { version: 2 }), blobs_v2 });
      for (const bad of [
        null,
        'x',
        5,
        [],
        { signature: 'AB' },
        { blob: goodBlob() },
        { ...entry(), blob: 3 },
        { ...entry(), signature: 3 },
        { ...entry(), manifest: 3 },
      ]) {
        expect(failureOf(v2([bad]), publisher.publicKeyHex)).toBe('invalid_format');
        expect(failureOf(v2([entry(), bad]), publisher.publicKeyHex)).toBe('invalid_format');
      }
    });

    it('comes before the key is compared', () => {
      expect(failureOf(without('blob'), testKey('unl-someone-else').publicKeyHex)).toBe('invalid_format');
    });
  });

  describe('the order of the checks', () => {
    it('compares the key before it looks at the manifest', () => {
      const body = list1(goodBlob());
      body.manifest = 'garbage';
      expect(failureOf(body, testKey('unl-someone-else').publicKeyHex)).toBe('untrusted_key');
    });

    it('reads the manifest before the signature', () => {
      const body = list1(goodBlob());
      body.manifest = 'garbage';
      body.signature = 'AB';
      expect(failureOf(body, publisher.publicKeyHex)).toBe('manifest_invalid');
    });

    it('checks the signature before the contents of the blob', () => {
      const body = list1(rawBlob('not json'));
      body.signature = 'AB'.repeat(32);
      expect(failureOf(body, publisher.publicKeyHex)).toBe('signature_invalid');
    });
  });

  describe('revoked', () => {
    it('is the answer to a list whose publisher manifest revokes the master key', () => {
      const body = list1(goodBlob(), { manifestSequence: REVOKED_SEQUENCE });
      expect(decodeManifest(hexOf(body.manifest as string), 'hex')).toMatchObject({ revoked: true });
      expect(failureOf(body, publisher.publicKeyHex)).toBe('revoked');
    });

    it('is not the answer to a revoking manifest that does not verify', () => {
      const body = list1(goodBlob(), { manifestSequence: REVOKED_SEQUENCE });
      body.manifest = base64Of(flipByte(hexOf(body.manifest as string), -10));
      expect(failureOf(body, publisher.publicKeyHex)).toBe('manifest_invalid');
    });
  });

  describe('signature_invalid', () => {
    it('is the answer to a blob signed by a key other than the signing key of the manifest', () => {
      const body = makeUnlResponse({
        publisher,
        publisherSigning: signing,
        blobs: [{ blob: goodBlob(), signer: testKey('unl-not-the-signing-key', 'ecdsa-secp256k1') }],
      });
      expect(failureOf(body, publisher.publicKeyHex)).toBe('signature_invalid');
    });

    it('is the answer to a blob signed by the master key, which is not the key of the manifest signature', () => {
      const body = makeUnlResponse({
        publisher,
        publisherSigning: signing,
        blobs: [{ blob: goodBlob(), signer: publisher }],
      });
      expect(failureOf(body, publisher.publicKeyHex)).toBe('signature_invalid');
    });

    it('is the answer to any blob of a version 2 list that is not signed', () => {
      const body = makeUnlResponse({
        publisher,
        publisherSigning: signing,
        version: 2,
        blobs: [
          { blob: goodBlob() },
          { blob: makeUnlBlob({ sequence: 8, expiration: NOW + 1, validators: [{ master: alpha }] }), signer: alpha },
        ],
      });
      expect(failureOf(body, publisher.publicKeyHex)).toBe('signature_invalid');
    });
  });

  describe('blob_invalid', () => {
    it('is the answer to a signed blob that is not JSON, or JSON that is not an object', () => {
      for (const blob of ['not json', '{', '', '[]', 'null', '"text"', '7']) {
        expect(blobFailure(rawBlob(blob))).toBe('blob_invalid');
      }
    });

    it('is the answer to a blob without sequence or expiration, or with them not integers', () => {
      const valid1 = valid();
      expect(blobFailure(rawBlob(valid1))).toBeUndefined();
      for (const field of ['sequence', 'expiration']) {
        const { [field]: _removed, ...rest } = valid1;
        expect(blobFailure(rawBlob(rest))).toBe('blob_invalid');
        for (const value of [null, '7', 1.5, -1, 2 ** 32, true, [], {}]) {
          expect(blobFailure(rawBlob(valid({ [field]: value })))).toBe('blob_invalid');
        }
      }
    });

    it('is the answer to an effective that is not an integer', () => {
      for (const value of [null, '5', 1.5, -1, true]) {
        expect(blobFailure(rawBlob(valid({ effective: value })))).toBe('blob_invalid');
      }
    });

    it('is the answer to an expiration that is not after the effective time', () => {
      const expiration = NOW + 3600 - RIPPLE_EPOCH;
      expect(blobFailure(rawBlob(valid({ effective: expiration - 1 })))).toBeUndefined();
      expect(blobFailure(rawBlob(valid({ effective: expiration })))).toBe('blob_invalid');
      expect(blobFailure(rawBlob(valid({ effective: expiration + 1 })))).toBe('blob_invalid');
    });

    it("is the answer to an expiration of 0 without an effective time, rippled's validFrom being 0", () => {
      expect(blobFailure(rawBlob(valid({ expiration: 0 })))).toBe('blob_invalid');
      expect(blobFailure(rawBlob(valid({ expiration: 1 })))).toBeUndefined();
      expect(blobFailure(rawBlob(valid({ expiration: 0, effective: 0 })))).toBe('blob_invalid');
    });

    it('is the answer to validators that are not a list of objects', () => {
      for (const validators of [undefined, null, 'x', 5, {}, [null], ['x'], [5], [[]], [{}]]) {
        expect(blobFailure(rawBlob(valid({ validators })))).toBe('blob_invalid');
      }
    });

    it('is the answer to a validator key that is not 33 bytes of hex of a known type', () => {
      const good = alpha.publicKeyHex;
      expect(blobFailure(rawBlob(valid({ validators: [{ validation_public_key: good }] })))).toBeUndefined();
      for (const key of [
        good.slice(0, 64),
        good + '00',
        good.slice(0, 65),
        'ZZ' + good.slice(2),
        '04' + good.slice(2),
        '',
        null,
        5,
      ]) {
        expect(blobFailure(rawBlob(valid({ validators: [{ validation_public_key: key }] })))).toBe('blob_invalid');
        expect(
          blobFailure(
            rawBlob(valid({ validators: [{ validation_public_key: good }, { validation_public_key: key }] })),
          ),
        ).toBe('blob_invalid');
      }
    });

    it('is the answer to a validator manifest that is not a string', () => {
      for (const manifest of [5, null, {}, []]) {
        expect(
          blobFailure(rawBlob(valid({ validators: [{ validation_public_key: alpha.publicKeyHex, manifest }] }))),
        ).toBe('blob_invalid');
      }
    });

    it('is the answer to any blob of a version 2 list that is not valid', () => {
      const body = makeUnlResponse({
        publisher,
        publisherSigning: signing,
        version: 2,
        blobs: [{ blob: goodBlob() }, { blob: rawBlob(valid({ expiration: undefined })) }],
      });
      expect(failureOf(body, publisher.publicKeyHex)).toBe('blob_invalid');
    });
  });

  describe('version 2', () => {
    const second = () =>
      makeUnlBlob({ sequence: 8, effective: NOW + 1800, expiration: NOW + 7200, validators: [{ master: beta }] });

    it('reads every blob', () => {
      const body = makeUnlResponse({
        publisher,
        publisherSigning: signing,
        version: 2,
        blobs: [{ blob: goodBlob() }, { blob: second() }],
        refreshInterval: 5,
      });
      expect(body.version).toBe(2);
      expect(body).not.toHaveProperty('blob');
      expect(body).not.toHaveProperty('signature');
      const list = verifyUnlList(body, publisher.publicKeyHex);
      expect(list.version).toBe(2);
      expect(list.refreshIntervalMinutes).toBe(5);
      expect(list.blobs.map((b) => [b.sequence, b.effective, b.expiration, b.validators.length])).toEqual([
        [7, undefined, NOW + 3600, 2],
        [8, NOW + 1800, NOW + 7200, 1],
      ]);
      expect(list.blobs[1].blobSha256).toBe(
        sha256Of(Buffer.from((body.blobs_v2 as { blob: string }[])[1].blob, 'base64')),
      );
    });

    it('reads any other version as 2, like rippled', () => {
      for (const version of [0, 2, 3, 99]) {
        const body = {
          ...makeUnlResponse({ publisher, publisherSigning: signing, version: 2, blobs: [{ blob: goodBlob() }] }),
          version,
        };
        expect(verifyUnlList(body, publisher.publicKeyHex).version).toBe(2);
      }
    });

    describe('the highest publisher manifest of the body signs every blob', () => {
      const oldSigning = signing;
      const newSigning = testKey('unl-publisher-new-signing');
      const second = () => makeUnlBlob({ sequence: 8, expiration: NOW + 7200, validators: [{ master: beta }] });
      const body = (entryManifestHex: string | undefined, signer: TestKey, publisherSequence = 5) => {
        const response = makeUnlResponse({
          publisher,
          publisherSigning: oldSigning,
          manifestSequence: publisherSequence,
          version: 2,
          blobs: [{ blob: goodBlob(), signer }],
        });
        if (entryManifestHex) (response.blobs_v2 as Body[])[0].manifest = base64Of(entryManifestHex);
        return response;
      };
      /** A v2 body of two blobs signed by `signers`, with `manifests[i]` (hex) as the own manifest of blob i. */
      const two = (signers: [TestKey, TestKey], manifests: [string?, string?]) => {
        const response = makeUnlResponse({
          publisher,
          publisherSigning: oldSigning,
          manifestSequence: 5,
          version: 2,
          blobs: [
            { blob: goodBlob(), signer: signers[0] },
            { blob: second(), signer: signers[1] },
          ],
        });
        manifests.forEach((hex, i) => {
          if (hex) (response.blobs_v2 as Body[])[i].manifest = base64Of(hex);
        });
        return response;
      };
      const entryManifest = (sequence: number, signingKey = newSigning, master = publisher) =>
        makeManifest({ master, signing: signingKey, sequence });

      it('replaces the publisher manifest when its sequence is higher', () => {
        expect(failureOf(body(undefined, newSigning), publisher.publicKeyHex)).toBe('signature_invalid');
        expect(failureOf(body(entryManifest(6), newSigning), publisher.publicKeyHex)).toBeUndefined();
        expect(failureOf(body(entryManifest(6), oldSigning), publisher.publicKeyHex)).toBe('signature_invalid');
      });

      it('answers the highest manifest as the manifest of the list', () => {
        const list = verifyUnlList(body(entryManifest(6), newSigning), publisher.publicKeyHex);
        expect(list.manifest).toEqual(decodeManifest(entryManifest(6), 'hex'));
        expect(list.manifest.sequence).toBe(6);
        expect(list.manifest.signingKey).toBe(newSigning.base58);
      });

      it('is ignored when its sequence is not higher', () => {
        for (const sequence of [5, 4, 1]) {
          expect(failureOf(body(entryManifest(sequence), newSigning), publisher.publicKeyHex)).toBe(
            'signature_invalid',
          );
          expect(failureOf(body(entryManifest(sequence), oldSigning), publisher.publicKeyHex)).toBeUndefined();
        }
        const list = verifyUnlList(body(entryManifest(4), oldSigning), publisher.publicKeyHex);
        expect(list.manifest.sequence).toBe(5);
      });

      it('applies to the other blobs, whichever blob carries it: a blob signed by the superseded key is refused', () => {
        const newer = entryManifest(6);
        expect(failureOf(two([newSigning, oldSigning], [newer, undefined]), publisher.publicKeyHex)).toBe(
          'signature_invalid',
        );
        expect(failureOf(two([oldSigning, newSigning], [undefined, newer]), publisher.publicKeyHex)).toBe(
          'signature_invalid',
        );
        expect(failureOf(two([oldSigning, newSigning], [newer, undefined]), publisher.publicKeyHex)).toBe(
          'signature_invalid',
        );
      });

      it('lets every blob be signed by the highest manifest key, with the manifest on one blob only', () => {
        const newer = entryManifest(6);
        for (const manifests of [
          [newer, undefined],
          [undefined, newer],
          [newer, newer],
        ] as [string?, string?][]) {
          const list = verifyUnlList(two([newSigning, newSigning], manifests), publisher.publicKeyHex);
          expect(list.blobs.map((blob) => blob.sequence)).toEqual([7, 8]);
          expect(list.manifest.sequence).toBe(6);
        }
      });

      it('takes the highest of several entry manifests', () => {
        const six = entryManifest(6);
        const seven = entryManifest(7, testKey('unl-publisher-newest-signing'));
        const newest = testKey('unl-publisher-newest-signing');
        expect(failureOf(two([newest, newest], [six, seven]), publisher.publicKeyHex)).toBeUndefined();
        expect(failureOf(two([newSigning, newSigning], [six, seven]), publisher.publicKeyHex)).toBe(
          'signature_invalid',
        );
        expect(failureOf(two([newest, newest], [seven, six]), publisher.publicKeyHex)).toBeUndefined();
      });

      it('is manifest_invalid when it does not decode, does not verify or names another master key', () => {
        const good = entryManifest(6);
        const response = body(good, newSigning);
        (response.blobs_v2 as Body[])[0].manifest = 'garbage';
        expect(failureOf(response, publisher.publicKeyHex)).toBe('manifest_invalid');

        expect(failureOf(body(flipByte(good, -10), newSigning), publisher.publicKeyHex)).toBe('manifest_invalid');
        expect(
          failureOf(
            body(entryManifest(6, newSigning, testKey('unl-other-master')), newSigning),
            publisher.publicKeyHex,
          ),
        ).toBe('manifest_invalid');
      });

      it('is manifest_invalid for any blob that carries a bad manifest, also one that would not be the highest', () => {
        const bad = flipByte(entryManifest(4), -10);
        expect(failureOf(two([oldSigning, oldSigning], [undefined, bad]), publisher.publicKeyHex)).toBe(
          'manifest_invalid',
        );
      });

      it('is revoked when it revokes the master key', () => {
        const revoking = makeManifest({ master: publisher, sequence: REVOKED_SEQUENCE });
        expect(failureOf(body(revoking, oldSigning), publisher.publicKeyHex)).toBe('revoked');
        expect(failureOf(two([oldSigning, oldSigning], [undefined, revoking]), publisher.publicKeyHex)).toBe('revoked');
      });
    });

    describe('knownManifest, the highest publisher manifest seen before', () => {
      const oldSigning = signing;
      const newSigning = testKey('unl-publisher-known-signing');
      const known = (sequence: number, signingKey: TestKey = newSigning, master: TestKey = publisher): Manifest =>
        decodeManifest(makeManifest({ master, signing: signingKey, sequence }), 'hex');
      /** A v1 body whose manifest has sequence `sequence` and key `oldSigning`; the blob is signed by `signer`. */
      const replay = (signer: TestKey, sequence = 5) =>
        makeUnlResponse({
          publisher,
          publisherSigning: oldSigning,
          manifestSequence: sequence,
          blobs: [{ blob: goodBlob(), signer }],
        });

      it('is optional: without it the manifest of the body decides', () => {
        expect(failureOf(replay(oldSigning), publisher.publicKeyHex)).toBeUndefined();
        expect(verifyUnlList(replay(oldSigning), publisher.publicKeyHex, undefined).manifest.sequence).toBe(5);
      });

      it('refuses a body that replays an older manifest with a blob signed by the superseded key', () => {
        expect(() => verifyUnlList(replay(oldSigning), publisher.publicKeyHex, known(6))).toThrow(UnlListError);
        try {
          verifyUnlList(replay(oldSigning), publisher.publicKeyHex, known(6));
        } catch (err) {
          expect((err as UnlListError).reason).toBe('signature_invalid');
        }
      });

      it('verifies the same blob signed by the key of the known manifest, and answers the known manifest', () => {
        const newer = known(6);
        const list = verifyUnlList(replay(newSigning), publisher.publicKeyHex, newer);
        expect(list.manifest).toEqual(newer);
        expect(list.blobs).toHaveLength(1);
        // Without the known manifest the same body is refused: its own manifest names the old key.
        expect(failureOf(replay(newSigning), publisher.publicKeyHex)).toBe('signature_invalid');
      });

      it('lets the known manifest win a tie, as the one seen first', () => {
        const tie = known(5);
        expect(verifyUnlList(replay(newSigning), publisher.publicKeyHex, tie).manifest).toEqual(tie);
        expect(() => verifyUnlList(replay(oldSigning), publisher.publicKeyHex, tie)).toThrow(UnlListError);
      });

      it('is beaten by a manifest of the body with a higher sequence', () => {
        const list = verifyUnlList(replay(oldSigning, 9), publisher.publicKeyHex, known(6));
        expect(list.manifest.sequence).toBe(9);
        expect(list.manifest.signingKey).toBe(oldSigning.base58);
        expect(failureOf(replay(newSigning, 9), publisher.publicKeyHex, known(6))).toBe('signature_invalid');
      });

      it('is beaten by a higher entry manifest of a version 2 body', () => {
        const response = makeUnlResponse({
          publisher,
          publisherSigning: oldSigning,
          manifestSequence: 5,
          version: 2,
          blobs: [{ blob: goodBlob(), signer: oldSigning }],
        });
        (response.blobs_v2 as Body[])[0].manifest = base64Of(
          makeManifest({ master: publisher, signing: oldSigning, sequence: 8 }),
        );
        const list = verifyUnlList(response, publisher.publicKeyHex, known(6));
        expect(list.manifest.sequence).toBe(8);
      });

      it('is revoked when the known manifest revokes the key', () => {
        const revoked = decodeManifest(makeManifest({ master: publisher, sequence: REVOKED_SEQUENCE }), 'hex');
        expect(revoked.revoked).toBe(true);
        expect(failureOf(replay(oldSigning), publisher.publicKeyHex, revoked)).toBe('revoked');
        expect(failureOf(replay(oldSigning, 9), publisher.publicKeyHex, revoked)).toBe('revoked');
      });

      it('is ignored when it is of another master key, e.g. after the configured key was changed', () => {
        const other = testKey('unl-other-publisher');
        const foreign = known(9, newSigning, other);
        const list = verifyUnlList(replay(oldSigning), publisher.publicKeyHex, foreign);
        expect(list.manifest.sequence).toBe(5);
        expect(failureOf(replay(newSigning), publisher.publicKeyHex, foreign)).toBe('signature_invalid');
        const foreignRevoked = decodeManifest(makeManifest({ master: other, sequence: REVOKED_SEQUENCE }), 'hex');
        expect(failureOf(replay(oldSigning), publisher.publicKeyHex, foreignRevoked)).toBeUndefined();
      });

      it('is ignored when it does not verify, or its fields do not say what its bytes say', () => {
        const good = known(9);
        const brokenBytes = decodeManifest(flipByte(good.hex, -10), 'hex');
        expect(failureOf(replay(oldSigning), publisher.publicKeyHex, brokenBytes)).toBeUndefined();
        expect(failureOf(replay(oldSigning), publisher.publicKeyHex, { ...good, sequence: 99 })).toBeUndefined();
        expect(failureOf(replay(oldSigning), publisher.publicKeyHex, { ...good, revoked: true })).toBeUndefined();
        const bogus = { ...good, hex: 'ZZ' };
        expect(failureOf(replay(oldSigning), publisher.publicKeyHex, bogus)).toBeUndefined();
      });

      it('is not changed', () => {
        const manifest = known(6);
        const before = JSON.stringify(manifest);
        verifyUnlList(replay(newSigning), publisher.publicKeyHex, manifest);
        expect(JSON.stringify(manifest)).toBe(before);
      });
    });
  });
});

describe('classifyUnlBlob', () => {
  const NOW = 1_800_000_000;
  const blob = (sequence: number, expiration: number, effective?: number): UnlBlob => ({
    sequence,
    expiration,
    ...(effective === undefined ? {} : { effective }),
    blobSha256: 'AB'.repeat(32),
    validators: [],
  });

  it('is stale below the newest stored sequence: 84 against 85', () => {
    expect(classifyUnlBlob(blob(84, NOW + 1000), 85, NOW)).toBe('stale');
  });

  it('is unchanged at the newest stored sequence: 85 against 85', () => {
    expect(classifyUnlBlob(blob(85, NOW + 1000), 85, NOW)).toBe('unchanged');
  });

  it('is new above the newest stored sequence, and when nothing is stored', () => {
    expect(classifyUnlBlob(blob(86, NOW + 1000), 85, NOW)).toBe('new');
    expect(classifyUnlBlob(blob(1, NOW + 1000), undefined, NOW)).toBe('new');
    expect(classifyUnlBlob(blob(0, NOW + 1000), 0, NOW)).toBe('unchanged');
  });

  it('is expired when it expires at or before now, and is newer than what is stored', () => {
    expect(classifyUnlBlob(blob(86, NOW - 1), 85, NOW)).toBe('expired');
    expect(classifyUnlBlob(blob(86, NOW), 85, NOW)).toBe('expired');
    expect(classifyUnlBlob(blob(86, NOW + 1), 85, NOW)).toBe('new');
    expect(classifyUnlBlob(blob(1, NOW - 1000), undefined, NOW)).toBe('expired');
  });

  it('decides on the sequence first: an old or equal blob is stale or unchanged even when it has expired', () => {
    expect(classifyUnlBlob(blob(84, NOW - 1000), 85, NOW)).toBe('stale');
    expect(classifyUnlBlob(blob(85, NOW - 1000), 85, NOW)).toBe('unchanged');
  });

  it('is new while its effective time is still ahead', () => {
    expect(classifyUnlBlob(blob(86, NOW + 5000, NOW + 100), 85, NOW)).toBe('new');
    expect(classifyUnlBlob(blob(86, NOW + 5000, NOW - 100), 85, NOW)).toBe('new');
  });

  it('classifies a recorded blob against the stored sequence', () => {
    const body = load('xrpl/unl/vl.ripple.com.json');
    const [recorded] = verifyUnlList(body, configuredKey('xrpl', 'vl.ripple.com')).blobs;
    expect(recorded.sequence).toBe(85);
    expect(classifyUnlBlob(recorded, 84, recorded.expiration - 1)).toBe('new');
    expect(classifyUnlBlob(recorded, 85, recorded.expiration - 1)).toBe('unchanged');
    expect(classifyUnlBlob(recorded, 86, recorded.expiration - 1)).toBe('stale');
    expect(classifyUnlBlob(recorded, undefined, recorded.expiration)).toBe('expired');
  });
});

describe('UnlListError', () => {
  it('carries the reason and a message', () => {
    const error = new UnlListError('signature_invalid', 'the blob signature does not verify');
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe('signature_invalid');
    expect(error.message).toBe('the blob signature does not verify');
    expect(error.name).toBe('UnlListError');
  });

  it('uses the reason as the message when it has none', () => {
    expect(new UnlListError('revoked').message).toBe('revoked');
  });
});
