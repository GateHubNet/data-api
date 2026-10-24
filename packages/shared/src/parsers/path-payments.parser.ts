import { BigNumber } from 'bignumber.js';
import { dropsToNative } from '../util/amount';
import { LedgerNode, ledgerNodes, poolsOf } from './amm.parser';
import { ParseContext, ParserTx } from './parser.interface';
import { deliveredAmount } from './payment.parser';

/**
 * A path payment (GLOSSARY.md): a successful Payment whose delivery used someone else's liquidity. Amounts are exact
 * decimal strings in whole units; an issuer is absent for the native currency.
 */
export interface ParsedPathPayment {
  source: string;
  destination: string;
  /** What reached the destination. */
  delivered_amount: string;
  currency: string;
  issuer?: string;
  /** What left the source for the payment, the fee not included. */
  source_amount: string;
  source_currency: string;
  source_issuer?: string;
  /** The order-book offers the payment consumed or changed. */
  offers_crossed: number;
  /** The AMM pools whose holdings it changed, in the order of their first node in the metadata. */
  amm_pools: string[];
  /** The accounts that rippled the payment between their trust lines, in the order of their first node. */
  rippled_through: string[];
}

type Json = Readonly<Record<string, any>>;

/** A trust line the transaction changed, from one of its two accounts: `before` and `after` are that account's balance. */
interface LineSide {
  account: string;
  /** The account on the other side of the line. */
  other: string;
  currency: string;
  before: BigNumber;
  after: BigNumber;
}

const ZERO = new BigNumber(0);

function isMpt(amount: unknown): boolean {
  return typeof amount === 'object' && amount !== null && (amount as Json).mpt_issuance_id !== undefined;
}

/**
 * Both sides of every trust line whose balance the transaction changed, in node order. The stored balance is the low
 * account's: positive when the high account owes it. A created line was 0 before it; a line without a previous balance
 * did not change.
 */
function lineSides(nodes: readonly LedgerNode[]): LineSide[] {
  const sides: LineSide[] = [];
  for (const node of nodes) {
    if (node.type !== 'RippleState' || node.fields.Balance === undefined) continue;
    const after = new BigNumber(node.fields.Balance.value);
    const before =
      node.op === 'CreatedNode'
        ? ZERO
        : node.previous.Balance !== undefined
          ? new BigNumber(node.previous.Balance.value)
          : after;
    if (before.eq(after)) continue;
    const low: string = node.fields.LowLimit?.issuer;
    const high: string = node.fields.HighLimit?.issuer;
    const currency: string = node.fields.Balance.currency;
    sides.push(
      { account: low, other: high, currency, before, after },
      { account: high, other: low, currency, before: before.negated(), after: after.negated() },
    );
  }
  return sides;
}

/** The issuer of a line side: the other account while `account` holds a balance on it, else `account` itself. */
const issuerOf = (side: LineSide): string => (side.before.gt(0) || side.after.gt(0) ? side.other : side.account);

/**
 * The order-book offers the transaction consumed or changed: Offer nodes, modified or deleted, whose `TakerPays` or
 * `TakerGets` moved. An offer removed unfunded or expired during the crossing has no previous amounts and is not
 * counted.
 */
function offersCrossed(nodes: readonly LedgerNode[]): LedgerNode[] {
  return nodes.filter(
    (n) =>
      n.type === 'Offer' &&
      n.op !== 'CreatedNode' &&
      (n.previous.TakerPays !== undefined || n.previous.TakerGets !== undefined),
  );
}

/** The AMM pools whose holdings the transaction changed: the pool's AccountRoot balance, or one of its reserve lines. */
function poolsCrossed(nodes: readonly LedgerNode[]): string[] {
  return poolsOf(nodes)
    .pools.filter(
      (pool) =>
        pool.root?.previous.Balance !== undefined || pool.lines.some((line) => line.previous.Balance !== undefined),
    )
    .map((pool) => pool.account);
}

/**
 * The accounts that rippled between their trust lines: for one currency, the payment raised the account's balance on
 * one line and lowered it on another, and the account holds a balance on one of them (an issuer only passing its own
 * currency from one holder to another is not rippling through someone's liquidity). The source, the destination, the
 * delivered currency's issuer, the AMM pools and the owners of the offers crossed (an offer between two issuers of one
 * currency moves its owner's lines the same way) are left out.
 */
function rippledThrough(sides: readonly LineSide[], excluded: ReadonlySet<string>): string[] {
  const groups = new Map<string, { account: string; up: boolean; down: boolean; holds: boolean }>();
  for (const side of sides) {
    if (excluded.has(side.account)) continue;
    const key = `${side.account}\u0000${side.currency}`;
    const group = groups.get(key) ?? { account: side.account, up: false, down: false, holds: false };
    if (side.after.gt(side.before)) group.up = true;
    else group.down = true;
    if (side.before.gt(0) || side.after.gt(0)) group.holds = true;
    groups.set(key, group);
  }
  const accounts: string[] = [];
  for (const group of groups.values()) {
    if (group.up && group.down && group.holds && !accounts.includes(group.account)) accounts.push(group.account);
  }
  return accounts;
}

/**
 * Detects path payments (GLOSSARY.md, spec #4 §4) in the metadata of every successful Payment, a payment to oneself
 * included (an arbitrage loop): the payments tables leave those out, so this does not hang off `PaymentParser`.
 *
 * A Payment is a path payment when its delivery consumed or changed an offer, changed an AMM pool, or rippled through
 * the trust lines of an account other than the source, the destination and the delivered currency's issuer. Only the
 * metadata counts: a `Paths` field that went unused changes nothing, and neither does rippling only through the issuer.
 * Payments of MPTs are not read.
 *
 * Pure: nothing in `t` is modified, and the result shares no objects with it.
 */
export class PathPaymentParser {
  parse(t: ParserTx, ctx: ParseContext): ParsedPathPayment | undefined {
    const { tx, meta } = t;
    if (tx.TransactionType !== 'Payment' || meta.TransactionResult !== 'tesSUCCESS') return undefined;
    if ([tx.Amount, tx.SendMax, meta.DeliveredAmount, meta.delivered_amount].some(isMpt)) return undefined;

    const nodes = ledgerNodes(meta);
    const sides = lineSides(nodes);
    const source: string = tx.Account;
    const destination: string = tx.Destination;

    const found = deliveredAmount(tx, meta, t.ledger_index, ctx);
    const delivered: unknown = found === 'unavailable' ? tx.Amount : found;
    const deliveredNative = typeof delivered !== 'object';
    const currency = deliveredNative ? ctx.nativeCurrency : (delivered as Json).currency;
    const issuer = deliveredNative
      ? undefined
      : this.issuer((delivered as Json).issuer, currency, destination, [source, destination], sides, 'credited');

    const offers = offersCrossed(nodes);
    const pools = poolsCrossed(nodes);
    const excluded = new Set([
      source,
      destination,
      ...(issuer !== undefined ? [issuer] : []),
      ...pools,
      ...offers.map((offer): string => offer.fields.Account),
    ]);
    const rippled = rippledThrough(sides, excluded);
    if (offers.length === 0 && pools.length === 0 && rippled.length === 0) return undefined;

    // as the payments tables store it: the token value as the node wrote it
    const deliveredValue: string = deliveredNative ? dropsToNative(delivered as string) : (delivered as Json).value;

    // Without SendMax the source spends the delivered currency; for a token rippled reads that as "any issuer the
    // source holds it from" (the source as issuer).
    const sendMax: unknown = tx.SendMax;
    const sourceNative = sendMax !== undefined ? typeof sendMax !== 'object' : deliveredNative;
    const sourceCurrency = sourceNative
      ? ctx.nativeCurrency
      : sendMax !== undefined
        ? (sendMax as Json).currency
        : currency;
    let sourceIssuer: string | undefined;
    if (!sourceNative) {
      const hint: string = sendMax !== undefined ? (sendMax as Json).issuer : source;
      sourceIssuer = this.issuer(hint, sourceCurrency, source, [source, destination], sides, 'debited');
      // a loop back to oneself in the same currency may leave the source's line higher than before
      if (sourceIssuer === source && source === destination && sourceCurrency === currency && issuer !== undefined) {
        sourceIssuer = issuer;
      }
    }

    // What the source's balance moved by, the fee not counted.
    let net: BigNumber;
    if (sourceNative) {
      const root = nodes.find((n) => n.type === 'AccountRoot' && n.fields.Account === source);
      const after = new BigNumber(root?.fields.Balance ?? 0);
      const before = root?.previous.Balance !== undefined ? new BigNumber(root.previous.Balance) : after;
      net = new BigNumber(dropsToNative(after.minus(before).plus(tx.Fee ?? '0')));
    } else {
      net = sides
        .filter(
          (s) =>
            s.account === source &&
            s.currency === sourceCurrency &&
            (sourceIssuer === source ? issuerOf(s) === source : s.other === sourceIssuer),
        )
        .reduce((sum, s) => sum.plus(s.after.minus(s.before)), ZERO);
    }
    // A payment to oneself in the asset it spends gets the delivered amount back on the same balance.
    const sameAsset = source === destination && sourceCurrency === currency && sourceIssuer === issuer;
    const sourceAmount = (sameAsset ? new BigNumber(deliveredValue).minus(net) : net.negated()).toString(10);

    return {
      source,
      destination,
      delivered_amount: deliveredValue,
      currency,
      ...(issuer !== undefined && { issuer }),
      source_amount: sourceAmount,
      source_currency: sourceCurrency,
      ...(sourceIssuer !== undefined && { source_issuer: sourceIssuer }),
      offers_crossed: offers.length,
      amm_pools: pools,
      rippled_through: rippled,
    };
  }

  /**
   * The issuer of a token amount. The amount's own issuer, unless it names a party to the payment, which means "any
   * issuer that party holds the currency from": then the first line of `account` in the currency that the payment
   * credited (the destination's side) or debited (the source's side) tells, and the party itself when it is the issuer
   * there.
   */
  private issuer(
    named: string,
    currency: string,
    account: string,
    parties: readonly string[],
    sides: readonly LineSide[],
    moved: 'credited' | 'debited',
  ): string {
    if (!parties.includes(named)) return named;
    const side = sides.find(
      (s) =>
        s.account === account &&
        s.currency === currency &&
        (moved === 'credited' ? s.after.gt(s.before) : s.after.lt(s.before)),
    );
    return side === undefined ? named : issuerOf(side);
  }
}
