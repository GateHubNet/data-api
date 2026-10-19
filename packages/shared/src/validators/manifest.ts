import { decode, encode } from 'ripple-binary-codec';
import { verify } from 'ripple-keypairs';
import { nodePublicKeyFromHex } from './node-key';

/** A manifest with this sequence revokes its master key: it has no signing key or signature, only the master signature. */
export const REVOKED_SEQUENCE = 0xffff_ffff;

/** A manifest as the rippled and xahaud `manifest` machinery reads it (F15). */
export interface Manifest {
  /** The master key, base58 (`nH...`). */
  masterKey: string;
  /** The master key, 66 upper-case hex digits. */
  masterKeyHex: string;
  sequence: number;
  revoked: boolean;
  /** The ephemeral signing key, base58 (`n9...`); none in a revoked manifest, which has no signing key. */
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
/** The fields rippled's `deserializeManifest` knows; a manifest with any other field is refused. */
const MANIFEST_FIELDS = new Set([
  'PublicKey',
  'MasterSignature',
  'Sequence',
  'Version',
  'Domain',
  'SigningPubKey',
  'Signature',
]);

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A manifest and the fields of its serialization. */
interface ParsedManifest {
  manifest: Manifest;
  fields: Record<string, unknown>;
}

/**
 * Read a serialized manifest, with the structure rippled's `deserializeManifest` demands (F15). An STObject
 * `{PublicKey, MasterSignature, Sequence, Version?, Domain?, SigningPubKey, Signature}`:
 *
 * - only a canonical encoding (`encode(decode(bytes))` gives the bytes back), and no field outside those listed;
 * - `PublicKey` (and `SigningPubKey`) a key of a known type (`02`, `03`, `ED`), `Version` 0 when present;
 * - a manifest that revokes (`Sequence` `0xFFFFFFFF`) has neither `SigningPubKey` nor `Signature`; any other has both,
 *   and its signing key is not its master key.
 *
 * `Domain` is not judged (`isProperlyFormedTomlDomain` does); an empty one counts as none. The signatures are not
 * checked here, `verifyManifest` does. Throws `ManifestError`.
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

  const unknown = Object.keys(fields).find((name) => !MANIFEST_FIELDS.has(name));
  if (unknown !== undefined) return fail(`the manifest has a field it should not have: ${unknown}`);
  if (fields.Version !== undefined && fields.Version !== 0) return fail('the manifest has a Version other than 0');

  const masterKeyHex = text(fields.PublicKey)?.toUpperCase();
  if (masterKeyHex === undefined || !KEY_HEX.test(masterKeyHex)) return fail('the master key is missing or not a key');
  if (text(fields.MasterSignature) === undefined) return fail('the master signature is missing');
  const sequence = fields.Sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence)) return fail('the sequence is missing');

  const revoked = sequence === REVOKED_SEQUENCE;
  const signingKeyHex = text(fields.SigningPubKey)?.toUpperCase();
  if (signingKeyHex !== undefined && !KEY_HEX.test(signingKeyHex)) return fail('the signing key is not a key');
  const hasSignature = fields.Signature !== undefined;
  if (hasSignature && text(fields.Signature) === undefined) return fail('the signature is not a signature');
  if (revoked) {
    if (signingKeyHex !== undefined || hasSignature) return fail('a revoking manifest has a signing key or signature');
  } else {
    if (signingKeyHex === undefined) return fail('the signing key is missing');
    if (!hasSignature) return fail('the signature is missing');
    if (signingKeyHex === masterKeyHex) return fail('the signing key is the master key');
  }

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
