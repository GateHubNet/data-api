import { BigNumber } from 'bignumber.js';
import { dropsToNative } from '../util/amount';
import { parseQuality } from '../util/quality';
import { ParseContext, ParserTx } from './parser.interface';

export interface ParsedExchange {
  base_currency: string;
  /** `''` for the native currency. */
  base_issuer: string;
  counter_currency: string;
  /** `''` for the native currency. */
  counter_issuer: string;
  /** Whole units, exact. */
  base_amount: string;
  /** Whole units, exact. */
  counter_amount: string;
  /** Counter per base, as BigNumber prints it: not rounded to 8 significant digits, that is for the API. */
  rate: string;
  buyer: string;
  seller: string;
  taker: string;
  /** Owner of the offer that was consumed. */
  provider: string;
  offer_sequence: number;
  /** Index of the offer's node in `meta.AffectedNodes`. */
  node_index: number;
  /** The currency on the far side of an XRP bridge when an OfferCreate between two issued currencies crossed XRP. */
  autobridged_currency?: string;
  autobridged_issuer?: string;
  tx_type: 'Payment' | 'OfferCreate';
}

/**
 * The key two sides of a pair are ordered by: the lower-cased currency followed by the lower-cased issuer.
 *
 * Byte-identical to the Ripple Data API, which built it as `currency + issuer` and so wrote the text `undefined` for a
 * native currency (`xrpundefined`, here `xahundefined`). Changing that would flip the base and counter of every pair
 * whose other currency sorts between the native code and `…undefined`.
 */
export function canonicalPairKey(currency: string, issuer?: string): string {
  return (currency + (issuer ?? 'undefined')).toLowerCase();
}

type Json = Readonly<Record<string, any>>;

/** One side of an exchange while it is being built. */
interface Side {
  currency: string;
  /** `undefined` for the native currency. */
  issuer: string | undefined;
  native: boolean;
  amount: string;
}

/** An issued-currency amount object (`currency`, `issuer`, `value`), as opposed to a drops string or an MPT amount. */
function isIssued(amount: unknown): amount is Json {
  return typeof amount === 'object' && amount !== null && typeof (amount as Json).currency === 'string';
}

/** A native amount (drops string) or an issued-currency one. An MPT amount is neither. */
function isSupported(amount: unknown): boolean {
  return typeof amount === 'string' || isIssued(amount);
}

/** The part of one side of the offer that was consumed. */
function consumed(before: unknown, after: unknown, ctx: ParseContext): Side {
  if (isIssued(before)) {
    const change = new BigNumber(before.value).minus((after as Json).value);
    return { currency: before.currency, issuer: before.issuer, native: false, amount: change.toString() };
  }
  const drops = new BigNumber(before as string).minus(after as string);
  return { currency: ctx.nativeCurrency, issuer: undefined, native: true, amount: dropsToNative(drops) };
}

/** The rate of a consumed offer: base per counter, from the offer's quality, else from the amounts that changed hands. */
function offerRate(bookDirectory: unknown, base: Side, counter: Side): BigNumber | undefined {
  const usable = (rate: BigNumber) => rate.isFinite() && rate.gt(0);
  try {
    const quality = parseQuality(bookDirectory as string, base.native, counter.native);
    if (usable(quality)) return quality;
  } catch {
    /* no usable book directory: use the amounts */
  }
  const ratio = new BigNumber(base.amount).dividedBy(counter.amount);
  return usable(ratio) ? ratio : undefined;
}

export class ExchangeParser {
  /**
   * Every offer a successful Payment or OfferCreate consumed, as an exchange. Matches `ledgerParser/exchanges.js` of
   * the Ripple Data API, so a Modified or Deleted Offer node counts when its `PreviousFields` carry both `TakerPays`
   * and `TakerGets`. Differences from the reference:
   * - the native currency is `ctx.nativeCurrency`, and "native" means an amount given in drops, not a currency code,
   *   so an issued currency called XAH on the XRP Ledger stays an issued currency;
   * - native amounts and issued amounts are exact decimal strings, with no Number in between;
   * - an exchange whose rate is neither in the book directory nor derivable from its amounts (a zero side) is left out
   *   instead of being stored with a NaN or Infinity rate, and so is an offer in an MPT amount.
   *
   * Pure: nothing in `t` is modified (the reference wrote `nodeIndex` into the metadata), and the result shares no
   * objects with it.
   */
  parse(t: ParserTx, ctx: ParseContext): ParsedExchange[] {
    const { tx, meta } = t;
    if (meta.TransactionResult !== 'tesSUCCESS') return [];
    if (tx.TransactionType !== 'Payment' && tx.TransactionType !== 'OfferCreate') return [];

    const exchanges: ParsedExchange[] = [];
    const nodes: readonly Json[] = meta.AffectedNodes ?? [];
    for (let index = 0; index < nodes.length; index++) {
      const node: Json | undefined = nodes[index]?.ModifiedNode || nodes[index]?.DeletedNode;
      if (!node || node.LedgerEntryType !== 'Offer') continue;
      const before: Json | undefined = node.PreviousFields;
      const after: Json | undefined = node.FinalFields;
      if (!before || !after || !before.TakerPays || !before.TakerGets) continue;
      if (!isSupported(before.TakerPays) || !isSupported(before.TakerGets)) continue;

      const exchange = this.exchange(t, ctx, node, index);
      if (exchange) exchanges.push(exchange);
    }
    return exchanges;
  }

  private exchange(t: ParserTx, ctx: ParseContext, node: Json, nodeIndex: number): ParsedExchange | undefined {
    const { tx } = t;
    const before: Json = node.PreviousFields;
    const after: Json = node.FinalFields;

    // The offer's owner pays TakerGets and receives TakerPays; the other party to the exchange is the transaction's
    // sender, who takes the offer. The exchange's base is what the owner receives.
    let base = consumed(before.TakerPays, after.TakerPays, ctx);
    let counter = consumed(before.TakerGets, after.TakerGets, ctx);
    const quality = offerRate(after.BookDirectory, base, counter);
    if (!quality) return undefined;

    const autobridged = tx.TransactionType === 'OfferCreate' ? this.autobridged(tx, base, counter) : undefined;

    let buyer: string = after.Account;
    let seller: string = tx.Account;
    let rate: string;
    if (canonicalPairKey(counter.currency, counter.issuer) < canonicalPairKey(base.currency, base.issuer)) {
      [base, counter] = [counter, base];
      [buyer, seller] = [seller, buyer];
      // The quality was base per counter, which is now counter per base.
      rate = quality.toString();
    } else {
      rate = quality.pow(-1).toString();
    }

    const exchange: ParsedExchange = {
      base_currency: base.currency,
      base_issuer: base.issuer ?? '',
      counter_currency: counter.currency,
      counter_issuer: counter.issuer ?? '',
      base_amount: base.amount,
      counter_amount: counter.amount,
      rate,
      buyer,
      seller,
      taker: tx.Account,
      provider: after.Account,
      offer_sequence: after.Sequence,
      node_index: nodeIndex,
      tx_type: tx.TransactionType,
    };
    if (autobridged) {
      exchange.autobridged_currency = autobridged.currency;
      exchange.autobridged_issuer = autobridged.issuer;
    }
    return exchange;
  }

  /**
   * An OfferCreate between two issued currencies that consumed an offer with a native side was bridged through the
   * native currency. The reference names the bridge by currency code alone, not by issuer: if the issued side of the
   * consumed offer has the code of the transaction's TakerPays the far side is TakerGets, else if it has TakerGets's
   * code the far side is TakerPays.
   */
  private autobridged(tx: Json, base: Side, counter: Side): { currency: string; issuer: string } | undefined {
    if (!isIssued(tx.TakerPays) || !isIssued(tx.TakerGets) || base.native === counter.native) return undefined;

    const issued = base.native ? counter : base;
    if (issued.currency === tx.TakerPays.currency)
      return { currency: tx.TakerGets.currency, issuer: tx.TakerGets.issuer };
    if (issued.currency === tx.TakerGets.currency)
      return { currency: tx.TakerPays.currency, issuer: tx.TakerPays.issuer };
    return undefined;
  }
}
