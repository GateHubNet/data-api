import { decodeNFTokenId, NFT_FLAGS, pageOwner, unscrambleTaxon } from './nftoken-id';

/** An id of the mainnet (Clio `nft_info` of `s1.ripple.com`, 2026-10-24): flags 8, fee 5000, taxon 500, serial 106293080. */
const RECORDED_ID = '00081388AF09C1D4B4D1E8031467F3508DFFADABEA73255FA9ECC9070655E758';

describe('decodeNFTokenId', () => {
  it('decodes a recorded id', () => {
    expect(decodeNFTokenId(RECORDED_ID)).toEqual({
      flags: 8,
      transferFee: 5000,
      issuer: 'rGxWAWXg8okZh29ojBRvEMpN5peQRV16Xu',
      scrambledTaxon: 0xa9ecc907,
      taxon: 500,
      serial: 106293080,
    });
  });

  it('unscrambles exactly for a serial above 2^24', () => {
    const { scrambledTaxon, serial, taxon } = decodeNFTokenId(RECORDED_ID);
    expect(serial).toBeGreaterThan(2 ** 24);
    // The product of the two 32-bit values is past 2^53 here, so a double product is off by a few units: this is the
    // value it would give, which is not the taxon.
    expect(384160001 * serial).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const inexact = (scrambledTaxon ^ ((384160001 * serial + 2459) % 2 ** 32)) >>> 0;
    expect(inexact).not.toBe(500);
    expect(unscrambleTaxon(scrambledTaxon, serial)).toBe(500);
    expect(taxon).toBe(500);
  });

  it('unscrambles as the exact integer formula for serials of every size', () => {
    const exact = (scrambled: number, serial: number): number =>
      Number(BigInt(scrambled) ^ ((384160001n * BigInt(serial) + 2459n) % 2n ** 32n));
    for (const serial of [0, 1, 2, 2 ** 24 - 1, 2 ** 24, 2 ** 24 + 1, 23_456_789, 106293080, 2 ** 31, 2 ** 32 - 1]) {
      for (const scrambled of [0, 1, 0xa9ecc907, 0x7fffffff, 0xffffffff]) {
        expect(unscrambleTaxon(scrambled, serial)).toBe(exact(scrambled, serial));
      }
    }
  });

  it('reads the id in any case, as the same NFT', () => {
    expect(decodeNFTokenId(RECORDED_ID.toLowerCase())).toEqual(decodeNFTokenId(RECORDED_ID));
  });

  it('refuses an id that is not 64 hex digits', () => {
    for (const bad of [
      RECORDED_ID.slice(1),
      `${RECORDED_ID}0`,
      `0x${RECORDED_ID.slice(2)}`,
      `G${RECORDED_ID.slice(1)}`,
      '',
    ]) {
      expect(() => decodeNFTokenId(bad)).toThrow(RangeError);
    }
  });
});

describe('pageOwner', () => {
  it('is the account of the first 20 bytes', () => {
    // A recorded NFTokenPage (ledger 107878781): the owner's AccountID, then 12 bytes of the page's own key.
    expect(pageOwner('40FEFE9E7C73D4F8A4DC7A7A09DD13B724827F9424827F945D1B3E9A061B05FF')).toBe(
      'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
    );
    // The last page of an owner has 0xFF…FF in its low 96 bits.
    expect(pageOwner('40FEFE9E7C73D4F8A4DC7A7A09DD13B724827F94FFFFFFFFFFFFFFFFFFFFFFFF')).toBe(
      'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
    );
  });

  it('refuses a key that is not 64 hex digits', () => {
    expect(() => pageOwner('40FEFE9E7C73D4F8A4DC7A7A09DD13B724827F94')).toThrow(RangeError);
    expect(() => pageOwner('')).toThrow(RangeError);
  });
});

describe('NFT_FLAGS', () => {
  it('has the five flags of an NFTokenID', () => {
    expect(NFT_FLAGS).toEqual({
      burnable: 0x0001,
      onlyXrp: 0x0002,
      trustLine: 0x0004,
      transferable: 0x0008,
      mutable: 0x0010,
    });
  });
});
