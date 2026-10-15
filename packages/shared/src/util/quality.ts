import BigNumber from 'bignumber.js';
import { Amount } from 'xrpl';

function adjustQualityForXRP(quality: string, pays: Amount, gets: Amount): BigNumber {
  const numeratorShift = pays === 'XRP' ? -6 : 0;
  const denominatorShift = gets === 'XRP' ? -6 : 0;
  const shift = numeratorShift - denominatorShift;
  return shift === 0 ? new BigNumber(quality) : new BigNumber(quality).shiftedBy(shift);
}

/** Decode the exchange rate encoded in the trailing 8 bytes of an order book directory. */
export function parseQuality(bookDirectory: string, pays: Amount, gets: Amount): BigNumber {
  const qualityHex = bookDirectory.substring(bookDirectory.length - 16);
  const mantissa = new BigNumber(qualityHex.substring(2), 16);
  const offset = parseInt(qualityHex.substring(0, 2), 16) - 100;
  const quality = mantissa.toString() + 'e' + offset.toString();
  return adjustQualityForXRP(quality, pays, gets);
}
