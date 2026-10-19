import { isNodePublicKey, nodePublicKeyFromHex } from '@gatehub/data-api-shared';
import { badRequest, notFound } from '../common/errors';
import type { Directory, DirectoryEntry } from './directory';

/**
 * The base58 key a request names (spec 3.3): a master key (`nH...`) or a signing key (`n9...`) as it is, or 66 hex digits
 * (`02`, `03` or `ED` first, in either case: the form the validator lists and the negative UNL write) as the base58 key.
 * Anything else, a classic address and the words of the other routes (`summary`) included, answers 400.
 */
export function parseValidatorKey(raw: string): string {
  if (isNodePublicKey(raw)) return raw;
  const fromHex = nodePublicKeyFromHex(raw);
  if (fromHex === undefined) throw badRequest('invalid validator public key');
  return fromHex;
}

/**
 * The validator a key names: the entry of a master key, or of the master a signing key maps to through the manifests. The
 * entries are every key of `validator_seen` and of the lists in use, whatever its age, so a validator last seen months ago
 * answers; a key the directory does not know answers 404.
 */
export function resolveValidator(
  directory: Pick<Directory, 'entries' | 'signingToMaster'>,
  key: string,
): DirectoryEntry {
  const entry = directory.entries.get(directory.signingToMaster.get(key) ?? key);
  if (entry === undefined) throw notFound('Validator not found');
  return entry;
}
