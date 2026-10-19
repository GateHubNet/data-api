import { readFileSync } from 'fs';
import { join } from 'path';
import { encode } from 'ripple-binary-codec';
import { makeManifest, TestKey, testKey } from '../test-utils/validator-keys';
import {
  decodeManifest,
  isProperlyFormedTomlDomain,
  Manifest,
  ManifestError,
  REVOKED_SEQUENCE,
  verifyManifest,
} from './manifest';
import { nodePublicKeyFromHex } from './node-key';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

interface RecordedList {
  public_key: string;
  manifest: string;
  blob: string;
}

/** The recorded list of a publisher, its publisher manifest and the validator entries of its blob. */
function recorded(file: string) {
  const list = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as RecordedList;
  const blob = JSON.parse(Buffer.from(list.blob, 'base64').toString('utf8')) as {
    validators: { validation_public_key: string; manifest?: string }[];
  };
  return { list, validators: blob.validators };
}

const RECORDED = ['xrpl/unl/vl.ripple.com.json', 'xrpl/unl/unl.xrplf.org.json', 'xahau/unl/vl.xahau.org.json'];

const hexOf = (base64: string) => Buffer.from(base64, 'base64').toString('hex').toUpperCase();

/** `hex` with the byte at byte offset `at` XOR-ed with 0x01. */
function flipByte(hex: string, at: number): string {
  const byte = parseInt(hex.slice(at * 2, at * 2 + 2), 16) ^ 0x01;
  return hex.slice(0, at * 2) + byte.toString(16).padStart(2, '0').toUpperCase() + hex.slice(at * 2 + 2);
}

describe('decodeManifest and verifyManifest on the recorded manifests', () => {
  it.each(RECORDED)('%s: the publisher manifest and every validator manifest decode, round-trip and verify', (file) => {
    const { list, validators } = recorded(file);
    expect(validators.length).toBeGreaterThan(0);

    const publisher = decodeManifest(list.manifest, 'base64');
    expect(publisher.masterKeyHex).toBe(list.public_key.toUpperCase());
    expect(publisher.revoked).toBe(false);
    expect(verifyManifest(publisher)).toBe(true);

    for (const validator of validators) {
      expect(validator.manifest).toBeDefined();
      const manifest = decodeManifest(validator.manifest as string, 'base64');
      expect(verifyManifest(manifest)).toBe(true);
      expect(manifest.revoked).toBe(false);
      expect(manifest.masterKeyHex).toBe(validator.validation_public_key.toUpperCase());
      expect(manifest.masterKey).toBe(nodePublicKeyFromHex(validator.validation_public_key));
      expect(manifest.hex).toBe(hexOf(validator.manifest as string));
      expect(manifest.signingKeyHex).toMatch(/^(?:02|03)[0-9A-F]{64}$/);
      expect(manifest.signingKey).toBe(nodePublicKeyFromHex(manifest.signingKeyHex as string));
      expect(manifest.signingKey).toMatch(/^n9/);
      expect(manifest.sequence).toBeGreaterThan(0);
      expect(manifest.sequence).toBeLessThan(REVOKED_SEQUENCE);
      if (manifest.domain !== undefined) expect(isProperlyFormedTomlDomain(manifest.domain)).toBe(true);
    }
  });

  it('reads the sequence, the domain and the keys of a recorded manifest', () => {
    const { validators } = recorded('xrpl/unl/vl.ripple.com.json');
    const manifest = decodeManifest(validators[0].manifest as string, 'base64');
    expect(manifest).toEqual({
      masterKey: nodePublicKeyFromHex('ED13AAFCB6A87BCB5D093C2EF37F04431C291126D674293305152D9776C6ABA4D6'),
      masterKeyHex: 'ED13AAFCB6A87BCB5D093C2EF37F04431C291126D674293305152D9776C6ABA4D6',
      sequence: 1,
      revoked: false,
      signingKey: nodePublicKeyFromHex('03D462A07256F0ACFA2239C738E92D6EF6DA1EC66AC096FCA2D82822EFB8E906D6'),
      signingKeyHex: '03D462A07256F0ACFA2239C738E92D6EF6DA1EC66AC096FCA2D82822EFB8E906D6',
      domain: 'xrp.vet',
      hex: hexOf(validators[0].manifest as string),
    });
  });

  it('leaves the domain out of a manifest without one', () => {
    const { validators } = recorded('xrpl/unl/vl.ripple.com.json');
    const manifest = decodeManifest(validators[1].manifest as string, 'base64');
    expect(manifest.domain).toBeUndefined();
    expect('domain' in manifest).toBe(false);
  });

  it('reads the same manifest from hex (any case) and from base64', () => {
    const { validators } = recorded('xahau/unl/vl.xahau.org.json');
    const base64 = validators[0].manifest as string;
    const fromBase64 = decodeManifest(base64, 'base64');
    expect(decodeManifest(hexOf(base64), 'hex')).toEqual(fromBase64);
    expect(decodeManifest(hexOf(base64).toLowerCase(), 'hex')).toEqual(fromBase64);
    expect(fromBase64.hex).toBe(hexOf(base64));
  });

  describe('a changed byte is never accepted', () => {
    const { validators } = recorded('xrpl/unl/vl.ripple.com.json');
    const hex = hexOf(validators[0].manifest as string);
    // Canonical layout: Sequence (5 bytes, 24 + uint32), PublicKey (35), SigningPubKey (35), Signature (2 + 70),
    // Domain (2 + 7), MasterSignature (3 + 64).
    const SEQUENCE_LAST_BYTE = 4;
    const MASTER_KEY_BYTE = 5 + 2 + 10;
    const SIGNING_KEY_BYTE = 5 + 35 + 2 + 10;
    const SIGNATURE_BYTE = 5 + 35 + 35 + 2 + 10;
    const DOMAIN_LAST_BYTE = 5 + 35 + 35 + 72 + 2 + 6;
    const MASTER_SIGNATURE_BYTE = hex.length / 2 - 10;

    it('knows the layout the offsets assume', () => {
      expect(hex.slice(0, 2)).toBe('24'); // Sequence
      expect(hex.slice(10, 14)).toBe('7121'); // PublicKey, 33 bytes
      expect(hex.slice(80, 84)).toBe('7321'); // SigningPubKey, 33 bytes
      expect(hex.slice(150, 152)).toBe('76'); // Signature
      expect(hex.slice((5 + 35 + 35 + 72) * 2, (5 + 35 + 35 + 72) * 2 + 2)).toBe('77'); // Domain
      expect(Buffer.from(hex.slice((DOMAIN_LAST_BYTE - 6) * 2), 'hex').toString('latin1')).toContain('xrp.vet');
    });

    it.each([
      ['Sequence', SEQUENCE_LAST_BYTE],
      ['PublicKey', MASTER_KEY_BYTE],
      ['SigningPubKey', SIGNING_KEY_BYTE],
      ['Signature', SIGNATURE_BYTE],
      ['Domain', DOMAIN_LAST_BYTE],
      ['MasterSignature', MASTER_SIGNATURE_BYTE],
    ])('flipping a byte of %s makes verifyManifest false', (_field, at) => {
      let decoded: Manifest | undefined;
      try {
        decoded = decodeManifest(flipByte(hex, at), 'hex');
      } catch (err) {
        // A changed key can stop being a point on the curve; the decoder may refuse it, which is as good.
        expect(err).toBeInstanceOf(ManifestError);
      }
      if (decoded) expect(verifyManifest(decoded)).toBe(false);
    });

    it('makes verifyManifest false when the sequence of the manifest object is changed', () => {
      const manifest = decodeManifest(hex, 'hex');
      expect(verifyManifest({ ...manifest, sequence: manifest.sequence + 1 })).toBe(false);
      expect(verifyManifest({ ...manifest, masterKeyHex: 'ED' + '11'.repeat(32) })).toBe(false);
      expect(verifyManifest({ ...manifest, domain: 'other.example' })).toBe(false);
      expect(verifyManifest({ ...manifest, revoked: true })).toBe(false);
    });

    it('changes Sequence when the flipped byte is the one asserted', () => {
      const manifest = decodeManifest(flipByte(hex, SEQUENCE_LAST_BYTE), 'hex');
      expect(manifest.sequence).toBe(0);
      expect(verifyManifest(manifest)).toBe(false);
    });
  });
});

describe('decodeManifest refuses what is not a manifest', () => {
  const { validators } = recorded('xrpl/unl/vl.ripple.com.json');
  const hex = hexOf(validators[0].manifest as string);

  const refused = (bytes: string, encoding: 'hex' | 'base64') => {
    let error: unknown;
    try {
      decodeManifest(bytes, encoding);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ManifestError);
    expect(error).toBeInstanceOf(Error);
    expect((error as ManifestError).reason).toBe('manifest_invalid');
    expect((error as ManifestError).message).not.toBe('');
  };

  it('refuses text that is not hex or not base64', () => {
    refused('', 'hex');
    refused('', 'base64');
    refused('ABC', 'hex'); // odd length
    refused('ZZ' + hex.slice(2), 'hex');
    refused(hex.slice(0, -1), 'hex');
    refused(' ' + hex, 'hex');
    refused('not a manifest', 'base64');
  });

  it('refuses bytes that are cut short or have more after the object', () => {
    refused(hex.slice(0, hex.length / 2), 'hex');
    refused(hex.slice(0, -2), 'hex');
    refused(hex + '00', 'hex');
    refused(hex + hex, 'hex');
  });

  it('refuses an encoding that is not the canonical one: the same fields in another order', () => {
    // Sequence (5 bytes) and PublicKey (35 bytes) swapped. The binary codec reads it, but encodes it back sorted.
    const swapped = hex.slice(10, 80) + hex.slice(0, 10) + hex.slice(80);
    expect(swapped).not.toBe(hex);
    refused(swapped, 'hex');
  });

  const master = testKey('manifest-master');
  const signing = testKey('manifest-signing');
  const complete = {
    Sequence: 3,
    PublicKey: master.publicKeyHex,
    SigningPubKey: signing.publicKeyHex,
    Signature: 'AB'.repeat(64),
    MasterSignature: 'CD'.repeat(64),
  };

  it('accepts the complete object used below, so that the refusals are for the missing or changed field', () => {
    const manifest = decodeManifest(encode(complete), 'hex');
    expect(manifest.sequence).toBe(3);
    expect(verifyManifest(manifest)).toBe(false); // the signatures are made up
  });

  it.each(['Sequence', 'PublicKey', 'SigningPubKey', 'Signature', 'MasterSignature'])(
    'refuses a manifest without %s',
    (field) => {
      const { [field]: _omitted, ...rest } = complete as Record<string, unknown>;
      refused(encode(rest), 'hex');
    },
  );

  it('refuses a master key or a signing key of an unknown type', () => {
    refused(encode({ ...complete, PublicKey: '04' + '11'.repeat(32) }), 'hex');
    refused(encode({ ...complete, SigningPubKey: '04' + '11'.repeat(32) }), 'hex');
    refused(encode({ ...complete, PublicKey: 'ED' + '11'.repeat(31) }), 'hex'); // 32 bytes
    refused(encode({ ...complete, SigningPubKey: '02' + '11'.repeat(31) }), 'hex');
  });

  it('refuses an object that is not a manifest at all', () => {
    refused(encode({ TransactionType: 'Payment', Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', Fee: '10' }), 'hex');
  });

  describe('the structure rippled reads (deserializeManifest), with real signatures so that only the structure is wrong', () => {
    /** The master signs the payload of F15 over `body`; `signedBy` adds a `Signature` of that payload. */
    const built = (body: Record<string, unknown>, signedBy?: TestKey) => {
      const payload = '4D414E00' + encode(body);
      return encode({
        ...body,
        MasterSignature: master.sign(payload),
        ...(signedBy ? { Signature: signedBy.sign(payload) } : {}),
      });
    };
    const ordinary = { Sequence: 3, PublicKey: master.publicKeyHex, SigningPubKey: signing.publicKeyHex };
    const revoking = { Sequence: REVOKED_SEQUENCE, PublicKey: master.publicKeyHex };

    it('reads the two well-formed shapes: signing key and signature, or a revocation with neither', () => {
      const ordinaryManifest = decodeManifest(built(ordinary, signing), 'hex');
      expect(ordinaryManifest).toMatchObject({ revoked: false, signingKeyHex: signing.publicKeyHex });
      expect(verifyManifest(ordinaryManifest)).toBe(true);
      const highest = decodeManifest(built({ ...ordinary, Sequence: REVOKED_SEQUENCE - 1 }, signing), 'hex');
      expect(highest.revoked).toBe(false); // the highest sequence that does not revoke
      const revokedManifest = decodeManifest(built(revoking), 'hex');
      expect(revokedManifest).toMatchObject({ revoked: true });
      expect(revokedManifest.signingKey).toBeUndefined();
      expect(verifyManifest(revokedManifest)).toBe(true);
    });

    it('refuses a revoked manifest that has a SigningPubKey, a Signature, or both', () => {
      refused(built({ ...revoking, SigningPubKey: signing.publicKeyHex }), 'hex');
      refused(built(revoking, signing), 'hex');
      refused(built({ ...revoking, SigningPubKey: signing.publicKeyHex }, signing), 'hex');
    });

    it('refuses a manifest that does not revoke and lacks the signing key or the signature', () => {
      refused(built(ordinary), 'hex'); // no Signature
      refused(built({ Sequence: 3, PublicKey: master.publicKeyHex }, signing), 'hex'); // no SigningPubKey
      refused(built({ Sequence: 3, PublicKey: master.publicKeyHex }), 'hex'); // neither
    });

    it('refuses a signing key that is the master key', () => {
      const same = { ...ordinary, SigningPubKey: master.publicKeyHex };
      refused(built(same, master), 'hex');
      expect(decodeManifest(built(ordinary, signing), 'hex').signingKeyHex).not.toBe(master.publicKeyHex);
    });

    it('accepts Version 0 and refuses any other Version', () => {
      const zero = decodeManifest(built({ ...ordinary, Version: 0 }, signing), 'hex');
      expect(zero.sequence).toBe(3);
      expect(verifyManifest(zero)).toBe(true);
      refused(built({ ...ordinary, Version: 1 }, signing), 'hex');
      refused(built({ ...ordinary, Version: 65535 }, signing), 'hex');
      refused(built({ ...revoking, Version: 1 }), 'hex');
    });

    it('refuses a field outside the manifest fields, even when both signatures cover it', () => {
      refused(built({ ...ordinary, Fee: '10' }, signing), 'hex');
      refused(built({ ...ordinary, Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' }, signing), 'hex');
      refused(built({ ...revoking, Flags: 1 }), 'hex');
    });

    it('keeps a Domain, which this code does not judge', () => {
      const body = { ...ordinary, Domain: Buffer.from('localhost').toString('hex').toUpperCase() };
      expect(decodeManifest(built(body, signing), 'hex').domain).toBe('localhost');
    });
  });
});

describe('made manifests', () => {
  const master = testKey('made-master');
  const signing = testKey('made-signing', 'ecdsa-secp256k1');

  it('verifies a manifest of an ed25519 master key and a secp256k1 signing key', () => {
    const manifest = decodeManifest(makeManifest({ master, signing, sequence: 7, domain: 'northpeak.example' }), 'hex');
    expect(manifest).toMatchObject({
      masterKeyHex: master.publicKeyHex,
      masterKey: master.base58,
      signingKeyHex: signing.publicKeyHex,
      signingKey: signing.base58,
      sequence: 7,
      revoked: false,
      domain: 'northpeak.example',
    });
    expect(master.publicKeyHex).toMatch(/^ED/);
    expect(signing.publicKeyHex).toMatch(/^0[23]/);
    expect(verifyManifest(manifest)).toBe(true);
  });

  it('verifies the other pairs of key types', () => {
    const ecdsaMaster = testKey('made-ecdsa-master', 'ecdsa-secp256k1');
    const edSigning = testKey('made-ed-signing');
    expect(
      verifyManifest(decodeManifest(makeManifest({ master: ecdsaMaster, signing: edSigning, sequence: 1 }), 'hex')),
    ).toBe(true);
    expect(verifyManifest(decodeManifest(makeManifest({ master: ecdsaMaster, signing, sequence: 1 }), 'hex'))).toBe(
      true,
    );
    expect(verifyManifest(decodeManifest(makeManifest({ master, signing: edSigning, sequence: 1 }), 'hex'))).toBe(true);
  });

  it('is deterministic: the same inputs make the same manifest', () => {
    const make = () => makeManifest({ master, signing, sequence: 2, domain: 'a.example' });
    expect(make()).toBe(make());
    expect(make()).toMatch(/^[0-9A-F]+$/);
  });

  it('checks both signatures over MAN\\0 and the object without them, independently of makeManifest', () => {
    const other = testKey('made-other', 'ecdsa-secp256k1');
    /** A manifest built here by hand: the two signatures made by the keys given, over the payload of F15. */
    const build = (masterSigner: TestKey, signingSigner: TestKey, extra: Record<string, unknown> = {}) => {
      const body = { Sequence: 1, PublicKey: master.publicKeyHex, SigningPubKey: signing.publicKeyHex, ...extra };
      const payload = '4D414E00' + encode(body);
      return encode({ ...body, Signature: signingSigner.sign(payload), MasterSignature: masterSigner.sign(payload) });
    };
    expect(verifyManifest(decodeManifest(build(master, signing), 'hex'))).toBe(true);
    expect(verifyManifest(decodeManifest(build(other, signing), 'hex'))).toBe(false); // master signature by another key
    expect(verifyManifest(decodeManifest(build(master, other), 'hex'))).toBe(false); // signature by another signing key
    expect(verifyManifest(decodeManifest(build(signing, master), 'hex'))).toBe(false); // the two swapped
  });

  it('does not verify a manifest whose signing key was replaced after signing', () => {
    const hex = makeManifest({ master, signing, sequence: 4 });
    const swapped = hex.replace(signing.publicKeyHex, testKey('made-replaced', 'ecdsa-secp256k1').publicKeyHex);
    expect(swapped).not.toBe(hex);
    expect(verifyManifest(decodeManifest(swapped, 'hex'))).toBe(false);
  });

  it('reads a revoked manifest: only the master signature, no signing key', () => {
    const revoked = decodeManifest(makeManifest({ master, sequence: REVOKED_SEQUENCE }), 'hex');
    expect(REVOKED_SEQUENCE).toBe(0xffffffff);
    expect(revoked.revoked).toBe(true);
    expect(revoked.sequence).toBe(REVOKED_SEQUENCE);
    expect(revoked.signingKey).toBeUndefined();
    expect(revoked.signingKeyHex).toBeUndefined();
    expect(verifyManifest(revoked)).toBe(true);
  });

  it('does not verify a revoked manifest with a changed master signature', () => {
    const hex = makeManifest({ master, sequence: REVOKED_SEQUENCE });
    const revoked = decodeManifest(flipByte(hex, hex.length / 2 - 5), 'hex');
    expect(revoked.revoked).toBe(true);
    expect(verifyManifest(revoked)).toBe(false);
  });

  it('does not verify a revoked manifest signed by another key than the master key', () => {
    const hex = makeManifest({ master, sequence: REVOKED_SEQUENCE });
    const manifest = decodeManifest(hex, 'hex');
    const swapped = hex.replace(master.publicKeyHex, testKey('made-not-the-master').publicKeyHex);
    expect(swapped).not.toBe(hex);
    expect(verifyManifest(decodeManifest(swapped, 'hex'))).toBe(false);
    expect(manifest.revoked).toBe(true);
  });

  it('needs a signing key unless it revokes', () => {
    expect(() => makeManifest({ master, sequence: 1 })).toThrow(/signing key/);
  });

  it('verifies a manifest with the domain localhost, which is not a properly formed TOML domain', () => {
    const manifest = decodeManifest(makeManifest({ master, signing, sequence: 1, domain: 'localhost' }), 'hex');
    expect(manifest.domain).toBe('localhost');
    expect(verifyManifest(manifest)).toBe(true);
    expect(isProperlyFormedTomlDomain('localhost')).toBe(false);
  });

  it('does not judge the domain: bytes outside ASCII come back one for one', () => {
    const manifest = decodeManifest(makeManifest({ master, signing, sequence: 1, domain: 'café.example' }), 'hex');
    expect(manifest.domain).toBe('café.example');
    expect(verifyManifest(manifest)).toBe(true);
    expect(isProperlyFormedTomlDomain(manifest.domain as string)).toBe(false);
  });

  it('leaves out an empty domain', () => {
    const manifest = decodeManifest(makeManifest({ master, signing, sequence: 1, domain: '' }), 'hex');
    expect(manifest.domain).toBeUndefined();
    expect(verifyManifest(manifest)).toBe(true);
  });

  it('keeps the signed bytes in upper-case hex', () => {
    const hex = makeManifest({ master, signing, sequence: 1 });
    expect(decodeManifest(hex.toLowerCase(), 'hex').hex).toBe(hex);
  });
});

describe('isProperlyFormedTomlDomain', () => {
  it('accepts domain names', () => {
    for (const domain of [
      'northpeak.example',
      'a-b.example.com',
      'xrp.vet',
      'a.io',
      'EXAMPLE.COM',
      'a1.b2.example',
      'xn--bcher-kva.example',
    ]) {
      expect(isProperlyFormedTomlDomain(domain)).toBe(true);
    }
  });

  it('refuses a label that starts or ends with a hyphen, IP literals, ports, paths and odd top-level domains', () => {
    for (const domain of [
      '-a.com',
      'a-.com',
      'a.-b.com',
      'a.b-.com',
      '1.2.3.4',
      'a.com:443',
      'a.com/x',
      'a.c0m',
      'abc',
      'localhost',
      'a.c',
      'a.com.',
      '.a.com',
      'a..com',
      'a_b.com',
      'a b.com',
      'a.com\n',
      '[::1]',
      'café.example',
      '',
    ]) {
      expect(isProperlyFormedTomlDomain(domain)).toBe(false);
    }
  });

  it('allows 4 to 128 characters', () => {
    expect(isProperlyFormedTomlDomain('a.io')).toBe(true); // 4
    expect(isProperlyFormedTomlDomain('a.b')).toBe(false); // 3
    const of = (length: number) => 'a'.repeat(63) + '.' + 'b'.repeat(length - 63 - 1 - 4) + '.com';
    expect(of(128)).toHaveLength(128);
    expect(isProperlyFormedTomlDomain(of(128))).toBe(true);
    expect(of(129)).toHaveLength(129);
    expect(isProperlyFormedTomlDomain(of(129))).toBe(false);
  });

  it('allows labels of 63 characters at most', () => {
    expect(isProperlyFormedTomlDomain('a'.repeat(63) + '.com')).toBe(true);
    expect(isProperlyFormedTomlDomain('a'.repeat(64) + '.com')).toBe(false);
    expect(isProperlyFormedTomlDomain('example.' + 'c'.repeat(63))).toBe(true);
    expect(isProperlyFormedTomlDomain('example.' + 'c'.repeat(64))).toBe(false);
  });
});
