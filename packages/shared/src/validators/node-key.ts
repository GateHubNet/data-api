import { decodeNodePublic, encodeNodePublic } from 'ripple-address-codec';

/** The key types a node public key can be: secp256k1 (`02`, `03` for the two parities of y) and ed25519 (`ED`). */
const KEY_HEX = /^(?:02|03|ED)[0-9A-F]{64}$/i;

/** True for a base58 node public key (`nH...` master keys, `n9...` signing keys) of a known type. */
export function isNodePublicKey(text: string): boolean {
  try {
    return KEY_HEX.test(Buffer.from(decodeNodePublic(text)).toString('hex'));
  } catch {
    return false;
  }
}

/** The base58 node public key of 66 hex digits (any case) starting `02`, `03` or `ED`; none for anything else. */
export function nodePublicKeyFromHex(hex: string): string | undefined {
  return KEY_HEX.test(hex) ? encodeNodePublic(Buffer.from(hex, 'hex')) : undefined;
}

/** The 66 upper-case hex digits of a base58 node public key. Throws when the text is not one. */
export function nodePublicKeyToHex(base58: string): string {
  return Buffer.from(decodeNodePublic(base58)).toString('hex').toUpperCase();
}
