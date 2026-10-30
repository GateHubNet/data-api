/**
 * The currency codes of the ledger and of the people who write them (spec 5.2). The ledger holds a currency as 3 characters
 * (the standard form) or as 40 hex digits (20 bytes); a client or a toml writes a code as 3 characters, as a text of 4 to 20
 * characters, or as the 40 hex digits.
 */

/** An LP token's currency (the AMM's): 40 upper-case hex digits whose first byte is 0x03. It counts for nothing in D6. */
export const LP_CURRENCY = /^03[0-9A-F]{38}$/;

export function isLpCurrency(currency: string): boolean {
  return LP_CURRENCY.test(currency);
}

/** A currency of 40 hex digits (20 bytes), in either case. */
export const HEX_CURRENCY_CODE = /^[0-9A-Fa-f]{40}$/;
/**
 * A 3-character code as the ledger takes it: rippled's `isoCharSet`, `A-Z a-z 0-9 ? ! @ # $ % ^ & * < > ( ) { } [ ] |`. The
 * ledger's JSON prints a standard-form currency as 3 characters only for these, and as 40 hex digits otherwise (`A-B`, `...`
 * and `"'+` are hex), so a currency of any other 3 characters is no currency of the ledger.
 */
export const STANDARD_CURRENCY_CODE = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
/** A text code a client or a toml writes: 4 to 20 characters of 0x20 to 0x7E. */
const TEXT_CODE = /^[\x20-\x7E]{4,20}$/;
/** The text a hex currency holds: 1 to 20 bytes of 0x20 to 0x7E. */
const TEXT_BYTES = /^[\x20-\x7E]{1,20}$/;
const ALL_ZERO = /^0{40}$/;
/** The bytes of a 20-byte currency that are not a standard code's: 0 to 11 and 15 to 19, all zero. */
const STANDARD_FORM_ZEROS = /^0{24}[0-9A-Fa-f]{6}0{10}$/;

/** The standard code a 40-digit hex holds (the first byte 0, bytes 12 to 14 the code, the rest 0), else `undefined`. */
function standardCodeOf(hex: string): string | undefined {
  if (!STANDARD_FORM_ZEROS.test(hex)) return undefined;
  const code = Buffer.from(hex.slice(24, 30), 'hex').toString('latin1');
  return STANDARD_CURRENCY_CODE.test(code) ? code : undefined;
}

/**
 * The `code` of an answer: a 3-character currency as it is; 40 hex digits as the standard code they hold (bytes 12-14, the rest
 * zero), else as their text when their bytes, trailing zeros dropped, are 1 to 20 printable ASCII (0x20-0x7E); else undefined
 * (an LP token's, the demurrage form, the all-zero hex and every other currency that is no text).
 */
export function currencyCode(currency: string): string | undefined {
  if (STANDARD_CURRENCY_CODE.test(currency)) return currency;
  if (!HEX_CURRENCY_CODE.test(currency)) return undefined;
  const standard = standardCodeOf(currency);
  if (standard !== undefined) return standard;
  const bytes = Buffer.from(currency, 'hex');
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  const text = bytes.subarray(0, end).toString('latin1');
  return TEXT_BYTES.test(text) ? text : undefined;
}

/**
 * The ledger's form of a code a client or a toml writes: 3 characters of the ledger's set (`STANDARD_CURRENCY_CODE`)
 * upper-cased; 40 hex digits (any case) upper-cased, or the 3 characters of the standard form they hold (if they are in that
 * set), upper-cased; a text of 4 to 20 characters of 0x20-0x7E as its 40 hex digits, zero-padded, upper case; anything else
 * (the all-zero hex included) undefined. Only a 3-character code is upper-cased, so `a.b.c` and `A.B.C` are two currencies.
 */
export function ledgerCurrencyOf(code: string): string | undefined {
  if (STANDARD_CURRENCY_CODE.test(code)) return code.toUpperCase();
  if (HEX_CURRENCY_CODE.test(code)) {
    const hex = code.toUpperCase();
    if (ALL_ZERO.test(hex)) return undefined;
    return standardCodeOf(hex)?.toUpperCase() ?? hex;
  }
  return TEXT_CODE.test(code) ? Buffer.from(code, 'latin1').toString('hex').toUpperCase().padEnd(40, '0') : undefined;
}
