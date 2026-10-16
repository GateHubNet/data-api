import { dropsToNative } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';

/** An amount of an offer as `account_offers` lists it: drops of the native currency as text, or a token. */
export type NodeAmount = string | { currency: string; issuer?: string; value: string };

/** An offer of an `account_offers` result; only the fields an order is made of. */
export interface NodeOffer {
  flags: number;
  seq: number;
  /** The rate the offer was placed at, TakerPays / TakerGets, with the native currency counted in drops. */
  quality?: string | number;
  taker_gets: NodeAmount;
  taker_pays: NodeAmount;
}

/** `{currency, value, counterparty?}`: the native currency has no counterparty. */
export interface OrderAmount {
  currency: string;
  value: string;
  counterparty?: string;
}

/**
 * An order as the Ripple API serves it (`formatOrder` of `lib/rippled.js`), keys in the order of the original.
 * A buy offers `totalPrice` for `quantity`, a sell gives up `quantity` for `totalPrice`.
 */
export interface OrderObject {
  specification: {
    direction: 'buy' | 'sell';
    quantity: OrderAmount;
    totalPrice: OrderAmount;
  };
  properties: {
    maker: string;
    flags: number;
    sequence: number;
    /** The quality, rescaled from drops to whole units of the native currency. */
    makerExchangeRate?: string;
  };
}

/** `lsfSell`: the offer was placed to sell (`tfSell`). */
export const SELL_FLAG = 0x00020000;

/** An amount in whole units: drops become the native currency, a token keeps its value and issuer (its counterparty). */
function orderAmount(amount: NodeAmount, native: string): OrderAmount {
  if (typeof amount === 'string') return { currency: native, value: dropsToNative(amount) };
  return {
    currency: amount.currency,
    value: amount.value,
    ...(amount.issuer !== undefined && { counterparty: amount.issuer }),
  };
}

/**
 * `adjustQualityForXRP` of the original: the quality divides TakerPays by TakerGets as the ledger stores them, so a
 * native side counts in drops, 10^6 to the whole unit. A native TakerPays makes the rate 10^6 too big, a native
 * TakerGets 10^6 too small; both, or neither, leave it as it is. Written the way BigNumber writes a number (exponent
 * form below 1e-7), as the original did.
 *
 * Which side is native is told by the amount (drops are text), not by the name of the currency, so that it holds on
 * Xahau too.
 */
function makerExchangeRate(quality: string | number | undefined, paysNative: boolean, getsNative: boolean) {
  if (quality === undefined) return undefined;
  const shift = (paysNative ? -6 : 0) - (getsNative ? -6 : 0);
  return shift === 0 ? String(quality) : new BigNumber(quality).shiftedBy(shift).toString();
}

/**
 * The order of an offer. The direction is the sell flag's (the original wrote `buy` for every offer, though it chose
 * the quantity and the price by the real direction): a buy's quantity is what it pays (TakerPays) for a total price of
 * what it gets (TakerGets); a sell is the other way round. `native` is the native currency code of the network.
 */
export function toOrderObject(offer: NodeOffer, maker: string, native: string): OrderObject {
  const direction = (offer.flags & SELL_FLAG) === 0 ? 'buy' : 'sell';
  const gets = orderAmount(offer.taker_gets, native);
  const pays = orderAmount(offer.taker_pays, native);
  const rate = makerExchangeRate(
    offer.quality,
    typeof offer.taker_pays === 'string',
    typeof offer.taker_gets === 'string',
  );

  return {
    specification: {
      direction,
      quantity: direction === 'buy' ? pays : gets,
      totalPrice: direction === 'buy' ? gets : pays,
    },
    properties: {
      maker,
      flags: offer.flags,
      sequence: offer.seq,
      ...(rate !== undefined && { makerExchangeRate: rate }),
    },
  };
}
