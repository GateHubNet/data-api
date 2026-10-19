import { createHash } from 'crypto';
import { verify } from 'ripple-keypairs';
import { decodeManifest, Manifest, ManifestError, verifyManifest } from './manifest';
import { nodePublicKeyFromHex } from './node-key';

/** Why a validator list was not accepted; the codes of the `outcome`/`reason` columns and metrics (spec 2.1). */
export type UnlFailure =
  | 'invalid_format'
  | 'untrusted_key'
  | 'manifest_invalid'
  | 'revoked'
  | 'signature_invalid'
  | 'blob_invalid';

export class UnlListError extends Error {
  constructor(
    readonly reason: UnlFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'UnlListError';
  }
}

/** One verified blob of a list. Times are unix seconds (converted from the Ripple epoch). */
export interface UnlBlob {
  sequence: number;
  effective?: number;
  expiration: number;
  /** SHA-256 of the blob as signed (the base64-decoded bytes), upper-case hex. */
  blobSha256: string;
  /** `masterKey` is base58; `manifest` is the validator's manifest in base64, as the blob has it. */
  validators: { masterKey: string; manifest?: string }[];
}

export interface VerifiedUnlList {
  version: 1 | 2;
  /** The configured publisher key, upper-case hex. */
  publisherKey: string;
  /** The publisher manifest of the list. */
  manifest: Manifest;
  blobs: UnlBlob[];
  /** `refresh_interval` of the body as it is (minutes); the fetcher clamps it. */
  refreshIntervalMinutes?: number;
}

/** Seconds between the Unix epoch and the Ripple epoch, 2000-01-01T00:00:00Z. */
const RIPPLE_EPOCH_OFFSET = 946_684_800;
const MAX_BLOBS_V2 = 5;
const UINT32_MAX = 0xffff_ffff;
const HEX = /^(?:[0-9A-F]{2})+$/i;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;

/** A blob and the signature over it, as the body gives them, and the manifest that comes with it (version 2 only). */
interface Entry {
  blob: string;
  signature: string;
  manifest?: string;
}

/** Step 1: the shape of the body. */
function entriesOf(body: Json): { version: 1 | 2; entries: Entry[] } {
  const invalid = (why: string): never => {
    throw new UnlListError('invalid_format', why);
  };
  if (typeof body.public_key !== 'string') invalid('public_key is missing');
  if (typeof body.manifest !== 'string') invalid('manifest is missing');
  if (typeof body.version !== 'number' || !Number.isInteger(body.version)) invalid('version is missing');

  if (body.version === 1) {
    if (typeof body.blob !== 'string' || typeof body.signature !== 'string')
      invalid('version 1 needs blob and signature');
    if ('blobs_v2' in body) invalid('version 1 has no blobs_v2');
    return { version: 1, entries: [{ blob: body.blob as string, signature: body.signature as string }] };
  }

  // Any other version is read as 2, like rippled.
  if ('blob' in body || 'signature' in body) invalid('version 2 has no blob or signature');
  const blobs = body.blobs_v2;
  if (!Array.isArray(blobs) || blobs.length < 1 || blobs.length > MAX_BLOBS_V2) {
    return invalid(`version 2 needs 1 to ${MAX_BLOBS_V2} blobs_v2`);
  }
  const entries = blobs.map((entry: unknown): Entry => {
    if (!isObject(entry) || typeof entry.blob !== 'string' || typeof entry.signature !== 'string') {
      return invalid('a blobs_v2 entry needs blob and signature');
    }
    if (entry.manifest !== undefined && typeof entry.manifest !== 'string')
      return invalid('a blobs_v2 manifest is not text');
    return {
      blob: entry.blob,
      signature: entry.signature,
      ...(entry.manifest === undefined ? {} : { manifest: entry.manifest }),
    };
  });
  return { version: 2, entries };
}

/** Decode a manifest of the list: one that is not the master key's own or does not verify is `manifest_invalid`. */
function manifestOf(base64: string, masterKeyHex: string, whose: string): Manifest {
  let manifest: Manifest;
  try {
    manifest = decodeManifest(base64, 'base64');
  } catch (err) {
    throw new UnlListError('manifest_invalid', `${whose}: ${err instanceof ManifestError ? err.message : String(err)}`);
  }
  if (manifest.masterKeyHex !== masterKeyHex) throw new UnlListError('manifest_invalid', `${whose} is for another key`);
  if (!verifyManifest(manifest)) throw new UnlListError('manifest_invalid', `${whose} does not verify`);
  if (manifest.revoked) throw new UnlListError('revoked', `${whose} revokes the publisher key`);
  return manifest;
}

/** Whether `signature` (hex) is the signature of `signingKeyHex` over `bytes`. */
function signedBlob(bytes: Buffer, signature: string, signingKeyHex: string | undefined): boolean {
  if (signingKeyHex === undefined || !HEX.test(signature)) return false;
  try {
    return verify(bytes.toString('hex'), signature, signingKeyHex);
  } catch {
    return false;
  }
}

/** Step 5: the contents of a signed blob. */
function parseBlob(bytes: Buffer): UnlBlob {
  const invalid = (why: string): never => {
    throw new UnlListError('blob_invalid', why);
  };
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalid('the blob is not JSON');
  }
  if (!isObject(json)) return invalid('the blob is not an object');
  const { sequence, expiration, effective, validators } = json;
  if (!isUint32(sequence)) return invalid('the blob has no integer sequence');
  if (!isUint32(expiration)) return invalid('the blob has no integer expiration');
  if (effective !== undefined && !isUint32(effective)) return invalid('the blob effective is not an integer');
  if (effective !== undefined && !(expiration > effective)) return invalid('the blob expires before it is effective');
  if (!Array.isArray(validators)) return invalid('the blob has no validators');

  return {
    sequence,
    ...(effective === undefined ? {} : { effective: effective + RIPPLE_EPOCH_OFFSET }),
    expiration: expiration + RIPPLE_EPOCH_OFFSET,
    blobSha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    validators: validators.map((entry: unknown) => {
      if (!isObject(entry) || typeof entry.validation_public_key !== 'string') {
        return invalid('a validator has no validation_public_key');
      }
      const masterKey = nodePublicKeyFromHex(entry.validation_public_key);
      if (masterKey === undefined) return invalid('a validation_public_key is not a 33-byte node key');
      if (entry.manifest !== undefined && typeof entry.manifest !== 'string')
        return invalid('a validator manifest is not text');
      return { masterKey, ...(entry.manifest === undefined ? {} : { manifest: entry.manifest }) };
    }),
  };
}

/**
 * Verify a validator list as fetched from a publisher (`body` is the parsed JSON, or its text), in the order of
 * rippled's `ValidatorList::verify` (spec 2.1; F14, F15):
 *
 * 1. the shape: `public_key`, `manifest` and `version` 1 (`blob`, `signature`) or 2 (`blobs_v2` of 1 to 5 entries) →
 *    `invalid_format`;
 * 2. `public_key` is `configuredKey` (any case) → `untrusted_key`;
 * 3. the publisher manifest is the key's own and verifies → `manifest_invalid`; a revoked one → `revoked`. A version 2
 *    entry's own manifest replaces it for that blob when its sequence is higher;
 * 4. each signature verifies over the decoded blob with the signing key of the manifest → `signature_invalid`;
 * 5. each blob has an integer `sequence` and `expiration`, an optional integer `effective` before the expiration, and
 *    `validators` with 33-byte node keys → `blob_invalid`.
 *
 * Times come back as unix seconds. Throws `UnlListError`.
 */
export function verifyUnlList(body: unknown, configuredKey: string): VerifiedUnlList {
  let parsed = body;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new UnlListError('invalid_format', 'the body is not JSON');
    }
  }
  if (!isObject(parsed)) throw new UnlListError('invalid_format', 'the body is not an object');
  const { version, entries } = entriesOf(parsed);

  const publisherKey = configuredKey.toUpperCase();
  if ((parsed.public_key as string).toUpperCase() !== publisherKey) {
    throw new UnlListError('untrusted_key', 'the list is not from the configured key');
  }

  const manifest = manifestOf(parsed.manifest as string, publisherKey, 'the publisher manifest');

  const blobs = entries.map((entry) => {
    let signer = manifest;
    if (entry.manifest !== undefined) {
      const own = manifestOf(entry.manifest, publisherKey, 'a blob manifest');
      if (own.sequence > manifest.sequence) signer = own;
    }
    const bytes = Buffer.from(entry.blob, 'base64');
    if (!signedBlob(bytes, entry.signature, signer.signingKeyHex)) {
      throw new UnlListError('signature_invalid', 'a blob signature does not verify');
    }
    return bytes;
  });

  const refresh = parsed.refresh_interval;
  return {
    version,
    publisherKey,
    manifest,
    blobs: blobs.map(parseBlob),
    ...(typeof refresh === 'number' && Number.isFinite(refresh) ? { refreshIntervalMinutes: refresh } : {}),
  };
}

/**
 * What to do with a verified blob, given the newest sequence stored for its publisher (none = nothing stored) and the
 * time: a lower sequence is `stale`, the same one `unchanged`; a newer one that has expired is `expired`, else `new`.
 * The `effective` time does not matter here.
 */
export function classifyUnlBlob(
  blob: UnlBlob,
  newestStoredSequence: number | undefined,
  nowSeconds: number,
): 'new' | 'unchanged' | 'stale' | 'expired' {
  if (newestStoredSequence !== undefined) {
    if (blob.sequence < newestStoredSequence) return 'stale';
    if (blob.sequence === newestStoredSequence) return 'unchanged';
  }
  return blob.expiration <= nowSeconds ? 'expired' : 'new';
}
