import { decode, encode } from 'ripple-binary-codec';
import { verify } from 'ripple-keypairs';
import { nodePublicKeyFromHex } from './node-key';

/** A manifest with this sequence revokes its master key: it has no signing key and only the master signature. */
export const REVOKED_SEQUENCE = 0xffff_ffff;

/** A manifest as the rippled and xahaud `manifest` machinery reads it (F15). */
export interface Manifest {
  /** The master key, base58 (`nH...`). */
  masterKey: string;
  /** The master key, 66 upper-case hex digits. */
  masterKeyHex: string;
  sequence: number;
  revoked: boolean;
  /** The ephemeral signing key, base58 (`n9...`); none in a revoked manifest. */
  signingKey?: string;
  signingKeyHex?: string;
  /** The `Domain` field as it was signed, one character per byte. Not judged here: `isProperlyFormedTomlDomain` does. */
  domain?: string;
  /** The serialized manifest, upper-case hex. */
  hex: string;
}

export class ManifestError extends Error {
  readonly reason = 'manifest_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** The bytes the two signatures of a manifest cover start with `HashPrefix::manifest`, `MAN\0`. */
const SIGNING_PREFIX = '4D414E00';
const HEX = /^(?:[0-9A-F]{2})+$/i;
const KEY_HEX = /^(?:02|03|ED)[0-9A-F]{64}$/i;
const SIGNATURE_FIELDS = ['Signature', 'MasterSignature'];

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A manifest and the fields of its serialization. */
interface ParsedManifest {
  manifest: Manifest;
  fields: Record<string, unknown>;
}

/**
 * Read a serialized manifest: an STObject `{PublicKey, MasterSignature, Sequence, Domain?, SigningPubKey, Signature}`.
 * Only a canonical encoding is accepted (`encode(decode(bytes))` has to give the bytes back), the master key and the
 * signing key have to be keys of a known type, and a manifest that does not revoke has to have a signing key and its
 * signature. Fields this code does not use are allowed, as in rippled; both signatures cover them. The signatures are
 * not checked here, `verifyManifest` does. Throws `ManifestError`.
 */
export function decodeManifest(bytes: string, encoding: 'hex' | 'base64'): Manifest {
  return parseManifest(bytes, encoding).manifest;
}

function parseManifest(bytes: string, encoding: 'hex' | 'base64'): ParsedManifest {
  const fail = (why: string): never => {
    throw new ManifestError(why);
  };
  const hex = (encoding === 'hex' ? bytes : Buffer.from(bytes, 'base64').toString('hex')).toUpperCase();
  if (!HEX.test(hex)) return fail(`the manifest is not ${encoding}`);

  let fields: Record<string, unknown>;
  try {
    fields = decode(hex) as unknown as Record<string, unknown>;
    if (encode(fields) !== hex) throw new Error('not the canonical encoding');
  } catch (err) {
    return fail(`the manifest does not decode: ${err instanceof Error ? err.message : String(err)}`);
  }

  const masterKeyHex = text(fields.PublicKey)?.toUpperCase();
  if (masterKeyHex === undefined || !KEY_HEX.test(masterKeyHex)) return fail('the master key is missing or not a key');
  if (text(fields.MasterSignature) === undefined) return fail('the master signature is missing');
  const sequence = fields.Sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence)) return fail('the sequence is missing');

  const revoked = sequence === REVOKED_SEQUENCE;
  const signingKeyHex = text(fields.SigningPubKey)?.toUpperCase();
  if (signingKeyHex !== undefined && !KEY_HEX.test(signingKeyHex)) return fail('the signing key is not a key');
  if (!revoked && signingKeyHex === undefined) return fail('the signing key is missing');
  if (!revoked && text(fields.Signature) === undefined) return fail('the signature is missing');

  const domain = text(fields.Domain);
  const manifest: Manifest = {
    masterKey: nodePublicKeyFromHex(masterKeyHex) as string,
    masterKeyHex,
    sequence,
    revoked,
    ...(signingKeyHex === undefined
      ? {}
      : { signingKey: nodePublicKeyFromHex(signingKeyHex) as string, signingKeyHex }),
    ...(domain ? { domain: Buffer.from(domain, 'hex').toString('latin1') } : {}),
    hex,
  };
  return { manifest, fields };
}

/** Whether `signature` is `key`'s signature over `payload` (hex); a malformed key or signature is just a no. */
function signedBy(payload: string, signature: unknown, key: string | undefined): boolean {
  try {
    return typeof signature === 'string' && key !== undefined && verify(payload, signature, key);
  } catch {
    return false;
  }
}

/**
 * Whether the manifest is signed: its master signature with its master key, and, unless it revokes, its signature with
 * its signing key, both over `MAN\0` + the serialized object without the two signature fields. The check is made on
 * the bytes in `m.hex`; a `Manifest` whose other fields do not say what those bytes say is not verified.
 */
export function verifyManifest(m: Manifest): boolean {
  let parsed: ParsedManifest;
  try {
    parsed = parseManifest(m.hex, 'hex');
  } catch {
    return false;
  }
  const { manifest: again, fields } = parsed;
  const same =
    again.masterKey === m.masterKey &&
    again.masterKeyHex === m.masterKeyHex &&
    again.sequence === m.sequence &&
    again.revoked === m.revoked &&
    again.signingKey === m.signingKey &&
    again.signingKeyHex === m.signingKeyHex &&
    again.domain === m.domain;
  if (!same) return false;

  const signed = Object.fromEntries(Object.entries(fields).filter(([name]) => !SIGNATURE_FIELDS.includes(name)));
  const payload = SIGNING_PREFIX + encode(signed);
  return (
    signedBy(payload, fields.MasterSignature, again.masterKeyHex) &&
    (again.revoked || signedBy(payload, fields.Signature, again.signingKeyHex))
  );
}

const TOML_DOMAIN = /^((?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;

/**
 * rippled's `isProperlyFormedTomlDomain` (F15): 4 to 128 characters, labels of letters, digits and hyphens that neither
 * start nor end with a hyphen, and an alphabetic top-level domain. This turns away IP literals, ports, paths and single
 * labels (`localhost`).
 */
export function isProperlyFormedTomlDomain(domain: string): boolean {
  return domain.length >= 4 && domain.length <= 128 && TOML_DOMAIN.test(domain);
}
