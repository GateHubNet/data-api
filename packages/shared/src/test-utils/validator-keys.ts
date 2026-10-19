/**
 * Test keys, manifests and validator lists. Everything here is made by this code with keys derived from a label, so a
 * test never needs a recorded file for the cases it builds, and the same call always gives the same bytes. The lists
 * these make are signed by test keys; they say nothing about a real publisher. Test-only: not exported from the package
 * barrel and excluded from the build. The specs of shared, the syncer and the API import it by relative path.
 */
import { createHash } from 'crypto';
import { encodeNodePublic } from 'ripple-address-codec';
import { encode } from 'ripple-binary-codec';
import { deriveKeypair, generateSeed, sign } from 'ripple-keypairs';
import { REVOKED_SEQUENCE } from '../validators/manifest';

/** Seconds between the Unix epoch and the Ripple epoch. */
const RIPPLE_EPOCH_OFFSET = 946_684_800;
/** The bytes the signatures of a manifest start with, `MAN\0`. */
const MANIFEST_PREFIX = '4D414E00';

export interface TestKey {
  /** 66 upper-case hex digits: `ED...` for ed25519, `02...` or `03...` for secp256k1. */
  publicKeyHex: string;
  /** The node public key in base58 (`nH...`). */
  base58: string;
  /** The signature (upper-case hex) over a message given as hex, made the way rippled signs it. */
  sign(messageHex: string): string;
}

/** A key from a label: the seed's entropy is the first 16 bytes of SHA-256(label). */
export function testKey(label: string, algorithm: 'ed25519' | 'ecdsa-secp256k1' = 'ed25519'): TestKey {
  const entropy = createHash('sha256').update(label).digest().subarray(0, 16);
  const seed = generateSeed({ entropy: Uint8Array.from(entropy), algorithm });
  const { publicKey, privateKey } = deriveKeypair(seed, { validator: true });
  return {
    publicKeyHex: publicKey.toUpperCase(),
    base58: encodeNodePublic(Buffer.from(publicKey, 'hex')),
    sign: (messageHex) => sign(messageHex, privateKey).toUpperCase(),
  };
}

/**
 * A manifest, signed, as upper-case hex. `signing` is the ephemeral key and is needed unless the sequence is
 * `REVOKED_SEQUENCE`, which makes a revocation: no signing key, only the master signature. `domain` is written byte for
 * byte (one byte per character).
 */
export function makeManifest(o: { master: TestKey; signing?: TestKey; sequence: number; domain?: string }): string {
  const revoked = o.sequence === REVOKED_SEQUENCE;
  if (!revoked && !o.signing) throw new Error('makeManifest needs a signing key unless it revokes');
  const body: Record<string, unknown> = {
    Sequence: o.sequence,
    PublicKey: o.master.publicKeyHex,
    ...(revoked || !o.signing ? {} : { SigningPubKey: o.signing.publicKeyHex }),
    ...(o.domain === undefined ? {} : { Domain: Buffer.from(o.domain, 'latin1').toString('hex').toUpperCase() }),
  };
  const payload = MANIFEST_PREFIX + encode(body);
  return encode({
    ...body,
    ...(revoked || !o.signing ? {} : { Signature: o.signing.sign(payload) }),
    MasterSignature: o.master.sign(payload),
  });
}

/**
 * A blob as a publisher signs it: base64 of the JSON `{sequence, expiration, effective?, validators}`. The times are
 * unix seconds here and Ripple-epoch seconds in the blob. A validator's manifest (hex) is written in base64.
 */
export function makeUnlBlob(o: {
  sequence: number;
  expiration: number;
  effective?: number;
  validators: { master: TestKey; manifestHex?: string }[];
}): string {
  const blob = {
    sequence: o.sequence,
    ...(o.effective === undefined ? {} : { effective: o.effective - RIPPLE_EPOCH_OFFSET }),
    expiration: o.expiration - RIPPLE_EPOCH_OFFSET,
    validators: o.validators.map((v) => ({
      validation_public_key: v.master.publicKeyHex,
      ...(v.manifestHex === undefined ? {} : { manifest: Buffer.from(v.manifestHex, 'hex').toString('base64') }),
    })),
  };
  return Buffer.from(JSON.stringify(blob)).toString('base64');
}

/**
 * The body a publisher serves: the publisher manifest (sequence `manifestSequence`, default 1, signed by `publisher`
 * and `publisherSigning`) and the blobs, each signed by `publisherSigning` unless a `signer` is given. Version 1 (the
 * default) takes exactly one blob and has `blob` and `signature`; version 2 has `blobs_v2`.
 */
export function makeUnlResponse(o: {
  publisher: TestKey;
  publisherSigning: TestKey;
  manifestSequence?: number;
  version?: 1 | 2;
  blobs: { blob: string; signer?: TestKey }[];
  refreshInterval?: number;
}): Record<string, unknown> {
  const version = o.version ?? 1;
  if (version === 1 && o.blobs.length !== 1) throw new Error('makeUnlResponse: version 1 takes exactly one blob');
  const signed = o.blobs.map(({ blob, signer }) => ({
    blob,
    signature: (signer ?? o.publisherSigning).sign(Buffer.from(blob, 'base64').toString('hex')),
  }));
  const manifest = makeManifest({
    master: o.publisher,
    signing: o.publisherSigning,
    sequence: o.manifestSequence ?? 1,
  });
  return {
    public_key: o.publisher.publicKeyHex,
    manifest: Buffer.from(manifest, 'hex').toString('base64'),
    ...(version === 1 ? signed[0] : { blobs_v2: signed }),
    ...(o.refreshInterval === undefined ? {} : { refresh_interval: o.refreshInterval }),
    version,
  };
}
