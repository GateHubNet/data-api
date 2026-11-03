import { isProperlyFormedTomlDomain } from '../validators/manifest';

/** The `Domain` field of an account holds at most 256 bytes: 512 hex digits. */
export const MAX_DOMAIN_HEX = 512;

const HEX = /^(?:[0-9A-Fa-f]{2})+$/;

/**
 * The domain an account's `Domain` field (hex) names, or `undefined` (spec 3.2): the hex has an even number of digits, at
 * most `MAX_DOMAIN_HEX`; every byte is printable ASCII (0x21 to 0x7E, so no space); the text is lower-cased and must be
 * accepted by `isProperlyFormedTomlDomain`. Nothing is trimmed.
 */
export function accountDomainOf(hex: string): string | undefined {
  if (hex.length > MAX_DOMAIN_HEX || !HEX.test(hex)) return undefined;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.some((byte) => byte < 0x21 || byte > 0x7e)) return undefined;
  const text = bytes.toString('latin1').toLowerCase();
  return isProperlyFormedTomlDomain(text) ? text : undefined;
}
