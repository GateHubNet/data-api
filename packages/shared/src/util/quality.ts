import BigNumber from 'bignumber.js';

/** Native amounts are counted in drops in the ledger: 10^6 per whole unit, for both XRP and XAH. */
const DROPS_SHIFT = -6;

/**
 * Decode the quality encoded in the trailing 8 bytes of an order book directory: `TakerPays / TakerGets` of the offers
 * in it, in whole units of each side.
 *
 * Ledger amounts count native currency in drops, so a native TakerPays divides the quality by 10^6 and a native
 * TakerGets multiplies it. This is `parseQuality` of `ripple-lib-extensions`, which the Ripple Data API copied.
 *
 * Like the reference it never throws: a directory that is not hex gives NaN, for the caller to check.
 */
export function parseQuality(bookDirectory: string, paysIsNative: boolean, getsIsNative: boolean): BigNumber {
  const qualityHex = bookDirectory.substring(bookDirectory.length - 16);
  const mantissa = new BigNumber(qualityHex.substring(2), 16);
  const offset = parseInt(qualityHex.substring(0, 2), 16) - 100;
  const quality = new BigNumber(`${mantissa.toString()}e${offset}`);

  const shift = (paysIsNative ? DROPS_SHIFT : 0) - (getsIsNative ? DROPS_SHIFT : 0);
  return shift === 0 ? quality : quality.shiftedBy(shift);
}
