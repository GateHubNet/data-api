import { encodeAccountID } from 'ripple-address-codec';

/** An `NFTokenID`, and the key of an `NFTokenPage`, is 32 bytes: 64 hex digits (the case does not matter). */
const HEX_256 = /^[0-9a-fA-F]{64}$/;

/** The flags of an `NFTokenID` (`lsfBurnable`, `lsfOnlyXRP`, `lsfTrustLine`, `lsfTransferable`, `lsfMutable`). */
export const NFT_FLAGS = {
  burnable: 0x0001,
  onlyXrp: 0x0002,
  trustLine: 0x0004,
  transferable: 0x0008,
  mutable: 0x0010,
} as const;

/** What an `NFTokenID` encodes: `Flags (2) | TransferFee (2) | Issuer (20) | scrambled Taxon (4) | Sequence (4)` bytes. */
export interface DecodedNFTokenId {
  flags: number;
  /** In 1/100000: 5000 is 5%. */
  transferFee: number;
  /** The classic address of the issuer. */
  issuer: string;
  /** The taxon as the id stores it. */
  scrambledTaxon: number;
  taxon: number;
  /** The id's sequence: the serial of the NFT among its issuer's mints. */
  serial: number;
}

/**
 * The taxon behind an id's scrambled one: `scrambled XOR ((384160001 × serial + 2459) mod 2^32)`. The product is taken
 * exactly, with `Math.imul` (the low 32 bits of the product of two 32-bit values): a double product is past 2^53 for a
 * serial above about 23 million and loses its low bits.
 */
export function unscrambleTaxon(scrambled: number, serial: number): number {
  return (scrambled ^ (Math.imul(384160001, serial) + 2459)) >>> 0;
}

/** Throws a `RangeError` unless `id` is 64 hex digits. */
function assertHex256(value: string, what: string): void {
  if (typeof value !== 'string' || !HEX_256.test(value)) {
    throw new RangeError(`${what} must be 64 hex digits: '${String(value)}'`);
  }
}

/** Splits an `NFTokenID` into the fields it encodes. Throws a `RangeError` unless `id` is 64 hex digits (any case). */
export function decodeNFTokenId(id: string): DecodedNFTokenId {
  assertHex256(id, 'an NFTokenID');
  const scrambledTaxon = parseInt(id.slice(48, 56), 16);
  const serial = parseInt(id.slice(56, 64), 16);
  return {
    flags: parseInt(id.slice(0, 4), 16),
    transferFee: parseInt(id.slice(4, 8), 16),
    issuer: encodeAccountID(Buffer.from(id.slice(8, 48), 'hex')),
    scrambledTaxon,
    taxon: unscrambleTaxon(scrambledTaxon, serial),
    serial,
  };
}

/**
 * The owner of an `NFTokenPage`: the classic address of the first 20 bytes of the page's key (`LedgerIndex`). Throws a
 * `RangeError` unless the key is 64 hex digits.
 */
export function pageOwner(pageIndex: string): string {
  assertHex256(pageIndex, 'an NFTokenPage key');
  return encodeAccountID(Buffer.from(pageIndex.slice(0, 40), 'hex'));
}
