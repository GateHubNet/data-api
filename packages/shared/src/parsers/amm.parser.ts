import { BigNumber } from 'bignumber.js';
import { Asset, canonicalPair } from '../query/asset';
import { dropsToNative } from '../util/amount';
import { amountsQuality, autobridgedThrough, exchangeRate } from './exchanges.parser';
import { ParseContext, ParserTx } from './parser.interface';

/**
 * A swap against a pool, stored as an `exchanges` row (spec §2.3) whose `provider` is the pool and `offer_sequence` 0.
 * Amounts are whole units, exact, with the native currency in whole units as in order-book rows.
 */
export interface ParsedAmmSwap {
  amm_account: string;
  /** Index in `meta.AffectedNodes` of the pool's AccountRoot node; without one, of its first lsfAMMNode trust line. */
  node_index: number;
  base_currency: string;
  /** `''` for the native currency. */
  base_issuer: string;
  counter_currency: string;
  /** `''` for the native currency. */
  counter_issuer: string;
  /** The pool's change of base, unsigned. */
  base_amount: string;
  /** The pool's change of counter, unsigned. */
  counter_amount: string;
  /** Counter per base, as `ExchangeParser` computes it for an offer owned by the pool with these amounts. */
  rate: string;
  /** Who received base: the taker when base flowed out of the pool, else the pool. */
  buyer: string;
  seller: string;
  /** The transaction's `Account`. */
  taker: string;
  /** The far side of the XRP bridge of an autobridged OfferCreate, by `ExchangeParser`'s rule. */
  autobridged_currency?: string;
  autobridged_issuer?: string;
}

/**
 * The state of a pool after a transaction that touched it (spec §2.6), in the pool's canonical pair order. A value is
 * present when a node of the transaction holds it and absent otherwise; readers carry the last known value forward.
 */
export interface ParsedAmmState {
  amm_account: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  /** Whole units, from the pool AccountRoot's `Balance` (native) or the pool's trust line with the issuer. */
  reserve_base?: string;
  reserve_counter?: string;
  /** `LPTokenBalance` of the AMM node; `'0'` when the AMM node is deleted. */
  lp_supply?: string;
  lp_currency?: string;
  /** In units of 1/100000. */
  trading_fee?: number;
  auction_holder?: string;
  /** LP tokens. */
  auction_price?: string;
  auction_discounted_fee?: number;
  auction_expiration?: number;
  /** The transaction deleted the pool: its AMM node or its AccountRoot is a `DeletedNode`. */
  deleted: boolean;
}

/** One create, deposit, withdraw, clawback or delete (spec §2.4). Amounts are signed: + into the pool, − out of it. */
export interface ParsedAmmLiquidity {
  amm_account: string;
  /** The liquidity provider: the transaction's `Account`, or the `Holder` of an AMMClawback. */
  account: string;
  /** The transaction's `Account`. */
  initiator: string;
  event: 'create' | 'deposit' | 'withdraw' | 'clawback' | 'delete';
  /** The AMMDeposit or AMMWithdraw mode its flags name; absent for the other events. */
  mode?: string;
  base_amount: string;
  counter_amount: string;
  /** The change of `LPTokenBalance`: + minted, − burned. */
  lp_tokens: string;
}

/** One AMMVote or AMMBid (spec §2.5). */
export interface ParsedAmmGovernance {
  amm_account: string;
  kind: 'vote' | 'bid';
  account: string;
  /** Vote: the transaction's `TradingFee`. */
  fee_voted?: number;
  /** Vote: the pool's `TradingFee` after the vote. */
  trading_fee_after?: number;
  /** Bid: `BidMin` and `BidMax`, in LP tokens. */
  bid_min?: string;
  bid_max?: string;
  /** Bid: the LP tokens the bid burned (the fall of `LPTokenBalance`). */
  price_paid?: string;
  /** Bid: the auction slot after the bid. */
  slot_holder?: string;
  slot_discounted_fee?: number;
  slot_expiration?: number;
  auth_accounts?: string[];
}

export interface ParsedAmm {
  swaps: ParsedAmmSwap[];
  states: ParsedAmmState[];
  liquidity: ParsedAmmLiquidity[];
  governance: ParsedAmmGovernance[];
  /**
   * Pools touched by the transaction for which no swap, liquidity event or governance row could be made (spec §2.3):
   * for example a pool in a Payment whose deltas are not one in and one out, a pool whose pair the nodes don't tell,
   * or an lsfAMMNode line whose pool cannot be told. For the `syncer_amm_unclassified_total` counter.
   */
  unclassified: number;
}

type Json = Readonly<Record<string, any>>;

/** `RippleState` flags: the line belongs to an AMM, and which side counts it against its reserve. */
const LSF_AMM_NODE = 0x01000000;
const LSF_LOW_RESERVE = 0x00010000;
const LSF_HIGH_RESERVE = 0x00020000;

const ZERO = new BigNumber(0);

/** The transaction flags that pick an AMMDeposit or AMMWithdraw mode, with the mode's name. */
const MODES: Readonly<Record<string, ReadonlyArray<readonly [number, string]>>> = {
  AMMDeposit: [
    [0x00010000, 'lp_token'],
    [0x00080000, 'single_asset'],
    [0x00100000, 'two_asset'],
    [0x00200000, 'one_asset_lp_token'],
    [0x00400000, 'limit_lp_token'],
    [0x00800000, 'two_asset_if_empty'],
  ],
  AMMWithdraw: [
    [0x00010000, 'lp_token'],
    [0x00020000, 'withdraw_all'],
    [0x00040000, 'one_asset_withdraw_all'],
    [0x00080000, 'single_asset'],
    [0x00100000, 'two_asset'],
    [0x00200000, 'one_asset_lp_token'],
    [0x00400000, 'limit_lp_token'],
  ],
};

const LIQUIDITY_EVENTS: Readonly<Record<string, ParsedAmmLiquidity['event']>> = {
  AMMCreate: 'create',
  AMMDeposit: 'deposit',
  AMMWithdraw: 'withdraw',
  AMMClawback: 'clawback',
  AMMDelete: 'delete',
};

/** One entry of `meta.AffectedNodes`. */
interface LedgerNode {
  index: number;
  op: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode';
  type: string;
  /** `NewFields` of a created entry, else `FinalFields`: the entry after the transaction, or as it was deleted. */
  fields: Json;
  /** `PreviousFields`: the fields the transaction changed, as they were before it. */
  previous: Json;
}

/** A pool and the nodes of the transaction that belong to it. */
interface Pool {
  account: string;
  /** The lowest index of its nodes: pools are listed in this order. */
  first: number;
  /** Its AccountRoot (the one with `AMMID`). */
  root?: LedgerNode;
  amm?: LedgerNode;
  /** Its reserve lines: the lsfAMMNode trust lines whose pool side it is, in node order. */
  lines: LedgerNode[];
}

/** How the transaction moved the pool's holding of one of its two assets. */
interface Holding {
  /** `issuer` is absent for the native currency. */
  asset: Asset;
  native: boolean;
  /** Drops for the native currency, whole units otherwise. */
  change: BigNumber;
  /** The holding after the transaction, in the same units; undefined when no node of the transaction holds it. */
  after?: BigNumber;
}

function ledgerNodes(meta: Json): LedgerNode[] {
  const nodes: LedgerNode[] = [];
  const entries: readonly Json[] = meta.AffectedNodes ?? [];
  entries.forEach((entry, index) => {
    const op = (['CreatedNode', 'ModifiedNode', 'DeletedNode'] as const).find((o) => entry?.[o]);
    if (!op) return;
    const body: Json = entry[op];
    const fields: Json | undefined = op === 'CreatedNode' ? body.NewFields : body.FinalFields;
    // A node without fields (an AccountRoot only threaded through, for example) says nothing about a pool.
    if (!fields) return;
    nodes.push({ index, op, type: body.LedgerEntryType, fields, previous: body.PreviousFields ?? {} });
  });
  return nodes;
}

const sameAsset = (a: Asset, b: Asset): boolean => a.currency === b.currency && (a.issuer ?? '') === (b.issuer ?? '');

/** The pool's side of a reserve line is the low side: the line's balance is then the pool's holding as it is. */
const poolIsLow = (pool: string, line: LedgerNode): boolean => line.fields.LowLimit?.issuer === pool;

/** The asset a reserve line holds for `pool`: its currency, issued by the other side. */
function lineAsset(pool: string, line: LedgerNode): Asset {
  const { fields } = line;
  return {
    currency: fields.Balance?.currency ?? fields.LowLimit?.currency,
    issuer: poolIsLow(pool, line) ? fields.HighLimit?.issuer : fields.LowLimit?.issuer,
  };
}

/**
 * The pool an lsfAMMNode line belongs to (ruling R-A6): the side that holds its reserve bit. A line with neither bit
 * (a deleted line: the bit is cleared as it is removed) or with both belongs to whichever of its two sides is a pool
 * named by an AccountRoot or AMM node of the same transaction; undefined if that is not exactly one side.
 */
function reserveSide(line: LedgerNode, named: ReadonlySet<string>): string | undefined {
  const flags: number = line.fields.Flags ?? 0;
  const low: string | undefined = line.fields.LowLimit?.issuer;
  const high: string | undefined = line.fields.HighLimit?.issuer;
  const lowReserve = (flags & LSF_LOW_RESERVE) !== 0;
  const highReserve = (flags & LSF_HIGH_RESERVE) !== 0;
  if (lowReserve !== highReserve) return lowReserve ? low : high;
  const sides = [low, high].filter((side): side is string => side !== undefined && named.has(side));
  return sides.length === 1 ? sides[0] : undefined;
}

/**
 * The pools of a transaction (spec §2.1 with ruling R-A6), in the order of their first node, and the number of
 * lsfAMMNode lines whose pool could not be told. Trust lines without lsfAMMNode, the LP-token lines the pool issues,
 * belong to no pool: an LP-token transfer touches none.
 */
function poolsOf(nodes: readonly LedgerNode[]): { pools: Pool[]; unresolved: number } {
  const pools = new Map<string, Pool>();
  const touch = (account: string, node: LedgerNode): Pool => {
    const pool = pools.get(account) ?? { account, first: node.index, lines: [] };
    pool.first = Math.min(pool.first, node.index);
    pools.set(account, pool);
    return pool;
  };

  for (const node of nodes) {
    if (node.type === 'AccountRoot' && node.fields.AMMID !== undefined) {
      const pool = touch(node.fields.Account, node);
      pool.root ??= node;
    } else if (node.type === 'AMM') {
      const pool = touch(node.fields.Account, node);
      pool.amm ??= node;
    }
  }

  const named = new Set(pools.keys());
  let unresolved = 0;
  for (const node of nodes) {
    if (node.type !== 'RippleState' || ((node.fields.Flags ?? 0) & LSF_AMM_NODE) === 0) continue;
    const account = reserveSide(node, named);
    if (account === undefined) unresolved++;
    else touch(account, node).lines.push(node);
  }
  return { pools: [...pools.values()].sort((a, b) => a.first - b.first), unresolved };
}

/**
 * An `Asset` or `Asset2` of an AMM node. Created nodes leave out fields at their default, so a missing asset is the
 * native currency, as is one without an issuer. Undefined for an asset this parser does not know (an MPT).
 */
function issueAsset(issue: Json | undefined, ctx: ParseContext): Asset | undefined {
  if (issue === undefined || (issue.issuer === undefined && issue.mpt_issuance_id === undefined)) {
    return { currency: ctx.nativeCurrency };
  }
  return typeof issue.issuer === 'string' ? { currency: issue.currency, issuer: issue.issuer } : undefined;
}

/**
 * The pool's two assets, base first. From the AMM node when it is in the metadata; otherwise the assets of the pool's
 * reserve lines, plus the native currency when the pool's AccountRoot shows a balance (an IOU/IOU pool holds no XRP).
 * Undefined unless that makes exactly two different assets.
 */
function pairOf(pool: Pool, ctx: ParseContext): [Asset, Asset] | undefined {
  let assets: (Asset | undefined)[];
  if (pool.amm) {
    assets = [issueAsset(pool.amm.fields.Asset, ctx), issueAsset(pool.amm.fields.Asset2, ctx)];
  } else {
    assets = [];
    for (const line of pool.lines) {
      const asset = lineAsset(pool.account, line);
      if (!assets.some((known) => known && sameAsset(known, asset))) assets.push(asset);
    }
    const root = pool.root;
    const holdsNative =
      root !== undefined &&
      [root.fields.Balance, root.previous.Balance].some((b) => b !== undefined && !new BigNumber(b).isZero());
    if (holdsNative) assets.push({ currency: ctx.nativeCurrency });
  }
  const [a, b] = assets;
  if (assets.length !== 2 || !a || !b || sameAsset(a, b)) return undefined;
  const { base, counter } = canonicalPair(a, b);
  return [base, counter];
}

/**
 * The pool's change of one asset from the node that holds it (spec §2.2): the AccountRoot's `Balance` for the native
 * currency, the reserve line with the asset's issuer otherwise, seen from the pool's side (negated when the pool is the
 * high account). A created node starts from nothing; a field missing from `PreviousFields` did not change.
 */
function holdingOf(pool: Pool, asset: Asset): Holding {
  if (asset.issuer === undefined) {
    const root = pool.root;
    if (!root) return { asset, native: true, change: ZERO };
    const after = new BigNumber(root.fields.Balance ?? 0);
    const before = root.op === 'CreatedNode' ? ZERO : new BigNumber(root.previous.Balance ?? after);
    return { asset, native: true, change: after.minus(before), after };
  }

  const line = pool.lines.find((l) => sameAsset(lineAsset(pool.account, l), asset));
  if (!line) return { asset, native: false, change: ZERO };
  const own = (value: unknown) => {
    const amount = new BigNumber((value as string | undefined) ?? 0);
    return poolIsLow(pool.account, line) ? amount : amount.negated();
  };
  const after = own(line.fields.Balance?.value);
  const before = line.op === 'CreatedNode' ? ZERO : own(line.previous.Balance?.value ?? line.fields.Balance?.value);
  return { asset, native: false, change: after.minus(before), after };
}

/** A holding's amount as stored: native drops in whole units, issued amounts as BigNumber prints them. */
const text = (holding: Holding, value: BigNumber): string => (holding.native ? dropsToNative(value) : value.toString());

/** The change of `LPTokenBalance`: all of it for a created node, all of it burned for a deleted one. */
function lpChange(amm: LedgerNode): BigNumber {
  const after = new BigNumber(amm.fields.LPTokenBalance?.value ?? 0);
  const before = amm.previous.LPTokenBalance ? new BigNumber(amm.previous.LPTokenBalance.value) : after;
  if (amm.op === 'CreatedNode') return after;
  if (amm.op === 'DeletedNode') return before.negated();
  return after.minus(before);
}

/** The mode of an AMMDeposit or AMMWithdraw: the one mode flag set. Undefined for other types, or none or several. */
function modeOf(tx: Json): string | undefined {
  const flags: number = tx.Flags ?? 0;
  const set = (MODES[tx.TransactionType] ?? []).filter(([flag]) => (flags & flag) !== 0);
  return set.length === 1 ? set[0][1] : undefined;
}

export class AmmParser {
  /**
   * The AMM rows of one transaction: swaps through pools, pool states, liquidity events and governance (spec §2). A
   * transaction that is not `tesSUCCESS` gives nothing: the parser runs on every transaction of a ledger, and a failed
   * one can still list pool nodes it only threaded through.
   *
   * Rows come in the order of each pool's first node in `meta.AffectedNodes`. No state is kept between transactions.
   *
   * Pure: nothing in `t` is modified, and the result shares no objects with it.
   */
  parse(t: ParserTx, ctx: ParseContext): ParsedAmm {
    const result: ParsedAmm = { swaps: [], states: [], liquidity: [], governance: [], unclassified: 0 };
    const { tx, meta } = t;
    if (meta.TransactionResult !== 'tesSUCCESS') return result;

    const { pools, unresolved } = poolsOf(ledgerNodes(meta));
    result.unclassified += unresolved;

    for (const pool of pools) {
      const pair = pairOf(pool, ctx);
      if (!pair) {
        result.unclassified++;
        continue;
      }
      const base = holdingOf(pool, pair[0]);
      const counter = holdingOf(pool, pair[1]);
      result.states.push(this.state(pool, base, counter));

      let classified = false;
      if (tx.TransactionType === 'Payment' || tx.TransactionType === 'OfferCreate') {
        const swap = this.swap(tx, pool, base, counter);
        if (swap) {
          result.swaps.push(swap);
          classified = true;
        }
      }
      const event = LIQUIDITY_EVENTS[tx.TransactionType];
      if (event && pool.amm) {
        result.liquidity.push(this.liquidity(tx, event, pool, pool.amm, base, counter));
        classified = true;
      }
      if ((tx.TransactionType === 'AMMVote' || tx.TransactionType === 'AMMBid') && pool.amm) {
        result.governance.push(this.governance(tx, pool, pool.amm));
        classified = true;
      }
      if (!classified) result.unclassified++;
    }
    return result;
  }

  private state(pool: Pool, base: Holding, counter: Holding): ParsedAmmState {
    const deleted = pool.amm?.op === 'DeletedNode' || pool.root?.op === 'DeletedNode';
    const amm = pool.amm?.fields;
    const slot: Json | undefined = amm?.AuctionSlot;
    return {
      amm_account: pool.account,
      base_currency: base.asset.currency,
      base_issuer: base.asset.issuer ?? '',
      counter_currency: counter.asset.currency,
      counter_issuer: counter.asset.issuer ?? '',
      ...(base.after ? { reserve_base: text(base, base.after) } : {}),
      ...(counter.after ? { reserve_counter: text(counter, counter.after) } : {}),
      ...(amm && (deleted || amm.LPTokenBalance) ? { lp_supply: deleted ? '0' : amm.LPTokenBalance.value } : {}),
      ...(amm?.LPTokenBalance ? { lp_currency: amm.LPTokenBalance.currency } : {}),
      ...(amm ? { trading_fee: amm.TradingFee ?? 0 } : {}),
      ...(slot?.Account !== undefined ? { auction_holder: slot.Account } : {}),
      ...(slot?.Price !== undefined ? { auction_price: slot.Price.value } : {}),
      ...(slot ? { auction_discounted_fee: slot.DiscountedFee ?? 0 } : {}),
      ...(slot?.Expiration !== undefined ? { auction_expiration: slot.Expiration } : {}),
      deleted,
    };
  }

  /** A swap when the pool took one asset in and gave the other out (spec §2.3), as an exchange with the pool as owner. */
  private swap(tx: Json, pool: Pool, base: Holding, counter: Holding): ParsedAmmSwap | undefined {
    const into = [base, counter].find((h) => h.change.isGreaterThan(0));
    const outOf = [base, counter].find((h) => h.change.isLessThan(0));
    const node = pool.root ?? pool.lines[0];
    if (!into || !outOf || !node) return undefined;

    const quality = amountsQuality(text(into, into.change), text(outOf, outOf.change.negated()));
    if (!quality) return undefined;
    const paidIsBase = outOf === base;
    const taker: string = tx.Account;

    const swap: ParsedAmmSwap = {
      amm_account: pool.account,
      node_index: node.index,
      base_currency: base.asset.currency,
      base_issuer: base.asset.issuer ?? '',
      counter_currency: counter.asset.currency,
      counter_issuer: counter.asset.issuer ?? '',
      base_amount: text(base, base.change.abs()),
      counter_amount: text(counter, counter.change.abs()),
      rate: exchangeRate(quality, paidIsBase),
      buyer: paidIsBase ? taker : pool.account,
      seller: paidIsBase ? pool.account : taker,
      taker,
    };
    if (tx.TransactionType === 'OfferCreate') {
      const bridge = autobridgedThrough(
        tx,
        { currency: base.asset.currency, native: base.native },
        { currency: counter.asset.currency, native: counter.native },
      );
      if (bridge) {
        swap.autobridged_currency = bridge.currency;
        swap.autobridged_issuer = bridge.issuer;
      }
    }
    return swap;
  }

  /** A liquidity event (spec §2.4): the pool's signed deltas and the change of its LP-token supply. */
  private liquidity(
    tx: Json,
    event: ParsedAmmLiquidity['event'],
    pool: Pool,
    amm: LedgerNode,
    base: Holding,
    counter: Holding,
  ): ParsedAmmLiquidity {
    const mode = modeOf(tx);
    return {
      amm_account: pool.account,
      account: event === 'clawback' ? tx.Holder : tx.Account,
      initiator: tx.Account,
      event,
      ...(mode !== undefined ? { mode } : {}),
      base_amount: text(base, base.change),
      counter_amount: text(counter, counter.change),
      lp_tokens: lpChange(amm).toString(),
    };
  }

  /** A vote or a bid (spec §2.5). */
  private governance(tx: Json, pool: Pool, amm: LedgerNode): ParsedAmmGovernance {
    if (tx.TransactionType === 'AMMVote') {
      return {
        amm_account: pool.account,
        kind: 'vote',
        account: tx.Account,
        ...(tx.TradingFee !== undefined ? { fee_voted: tx.TradingFee } : {}),
        trading_fee_after: amm.fields.TradingFee ?? 0,
      };
    }
    const slot: Json | undefined = amm.fields.AuctionSlot;
    const authAccounts: readonly Json[] = slot?.AuthAccounts ?? [];
    return {
      amm_account: pool.account,
      kind: 'bid',
      account: tx.Account,
      ...(tx.BidMin !== undefined ? { bid_min: tx.BidMin.value } : {}),
      ...(tx.BidMax !== undefined ? { bid_max: tx.BidMax.value } : {}),
      price_paid: lpChange(amm).negated().toString(),
      ...(slot?.Account !== undefined ? { slot_holder: slot.Account } : {}),
      ...(slot ? { slot_discounted_fee: slot.DiscountedFee ?? 0 } : {}),
      ...(slot?.Expiration !== undefined ? { slot_expiration: slot.Expiration } : {}),
      auth_accounts: authAccounts.map((entry) => entry.AuthAccount.Account as string),
    };
  }
}
