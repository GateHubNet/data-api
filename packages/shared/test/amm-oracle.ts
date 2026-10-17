import BigNumber from 'bignumber.js';

/**
 * The oracle of the AMM parser tests: what `AmmParser.parse` has to return for one transaction, worked out from the
 * transaction and its metadata in plain JavaScript and BigNumber by the rules of section 2 of the AMM spec
 * (`docs/superpowers/specs/2026-10-17-amm-data-design.md`, with ruling R-A6). It never uses the parser or its helpers:
 * pool detection, deltas, the canonical pair order, the rate and the formatting are written out again here, so a
 * mistake in one of them shows up as a difference.
 *
 * Used by `src/parsers/amm.parser.spec.ts`, which compares the two over every recorded and synthetic AMM case.
 */

type Json = Record<string, any>;
type Row = Record<string, unknown>;

export interface OracleResult {
  swaps: Row[];
  states: Row[];
  liquidity: Row[];
  governance: Row[];
  unclassified: number;
}

const FLAG_AMM_NODE = 0x01000000;
const FLAG_LOW_RESERVE = 0x00010000;
const FLAG_HIGH_RESERVE = 0x00020000;

/** Spec §1, `amm_liquidity.mode`: the mode flags of AMMDeposit and AMMWithdraw. */
const MODES: Record<string, Record<string, number>> = {
  AMMDeposit: {
    lp_token: 0x00010000,
    single_asset: 0x00080000,
    two_asset: 0x00100000,
    one_asset_lp_token: 0x00200000,
    limit_lp_token: 0x00400000,
    two_asset_if_empty: 0x00800000,
  },
  AMMWithdraw: {
    lp_token: 0x00010000,
    withdraw_all: 0x00020000,
    one_asset_withdraw_all: 0x00040000,
    single_asset: 0x00080000,
    two_asset: 0x00100000,
    one_asset_lp_token: 0x00200000,
    limit_lp_token: 0x00400000,
  },
};

const EVENTS: Record<string, string> = {
  AMMCreate: 'create',
  AMMDeposit: 'deposit',
  AMMWithdraw: 'withdraw',
  AMMClawback: 'clawback',
  AMMDelete: 'delete',
};

/** One entry of `AffectedNodes`: `now` is NewFields or FinalFields, `was` is PreviousFields (empty if none). */
interface Entry {
  index: number;
  op: string;
  type: string;
  now: Json | undefined;
  was: Json;
}

/** An asset of a pool. `issuer` is undefined for the native currency. */
interface PoolAsset {
  currency: string;
  issuer: string | undefined;
}

const sameAsset = (a: PoolAsset, b: PoolAsset) => a.currency === b.currency && a.issuer === b.issuer;

/** Whole native units from drops, written out in plain notation. */
const fromDrops = (drops: BigNumber) => drops.shiftedBy(-6).toFixed();

/** The order key of the Ripple Data API: currency then issuer, lower-cased, with the text `undefined` for native. */
const orderKey = (a: PoolAsset) => `${a.currency}${a.issuer === undefined ? 'undefined' : a.issuer}`.toLowerCase();

export function ammOracle(tx: Json, meta: Json, nativeCurrency: string): OracleResult {
  const result: OracleResult = { swaps: [], states: [], liquidity: [], governance: [], unclassified: 0 };
  if (meta.TransactionResult !== 'tesSUCCESS') return result;

  const entries: Entry[] = (meta.AffectedNodes ?? []).map((wrapper: Json, index: number) => {
    const op = Object.keys(wrapper)[0];
    const body = wrapper[op];
    return {
      index,
      op,
      type: body.LedgerEntryType,
      now: body.NewFields ?? body.FinalFields,
      was: body.PreviousFields ?? {},
    };
  });

  // §2.1: pools named by an AccountRoot that has an AMMID, or by an AMM node.
  const named = new Set<string>();
  for (const e of entries) {
    if (!e.now) continue;
    if (e.type === 'AccountRoot' && e.now.AMMID !== undefined) named.add(e.now.Account);
    if (e.type === 'AMM') named.add(e.now.Account);
  }

  // §2.1 (R-A6): the pool of an lsfAMMNode trust line is the side holding the reserve bit; with no bit (or both) it
  // is the one side already named by an AccountRoot or AMM node. A line that names no pool is counted.
  const lineOwner = new Map<Entry, string>();
  for (const e of entries) {
    if (e.type !== 'RippleState' || !e.now) continue;
    const flags = e.now.Flags ?? 0;
    if ((flags & FLAG_AMM_NODE) === 0) continue;
    const low: string = e.now.LowLimit.issuer;
    const high: string = e.now.HighLimit.issuer;
    const lowBit = (flags & FLAG_LOW_RESERVE) !== 0;
    const highBit = (flags & FLAG_HIGH_RESERVE) !== 0;
    let owner: string | undefined;
    if (lowBit !== highBit) owner = lowBit ? low : high;
    else {
      const candidates = [low, high].filter((a) => named.has(a));
      if (candidates.length === 1) owner = candidates[0];
    }
    if (owner === undefined) result.unclassified += 1;
    else lineOwner.set(e, owner);
  }

  // Every pool with the entries that belong to it, in the order of its first entry.
  const pools = new Map<string, { root?: Entry; amm?: Entry; lines: Entry[]; first: number }>();
  const poolOf = (account: string, index: number) => {
    let pool = pools.get(account);
    if (!pool) {
      pool = { lines: [], first: index };
      pools.set(account, pool);
    }
    pool.first = Math.min(pool.first, index);
    return pool;
  };
  for (const e of entries) {
    if (!e.now) continue;
    if (e.type === 'AccountRoot' && e.now.AMMID !== undefined) poolOf(e.now.Account, e.index).root ??= e;
    if (e.type === 'AMM') poolOf(e.now.Account, e.index).amm ??= e;
    const owner = lineOwner.get(e);
    if (owner !== undefined) poolOf(owner, e.index).lines.push(e);
  }
  const ordered = [...pools.entries()].sort((a, b) => a[1].first - b[1].first);

  const isSwapTx = tx.TransactionType === 'Payment' || tx.TransactionType === 'OfferCreate';

  for (const [account, pool] of ordered) {
    const { root, amm, lines } = pool;
    const ownSign = (line: Entry) => (line.now!.LowLimit.issuer === account ? 1 : -1);
    const lineAsset = (line: Entry): PoolAsset => ({
      currency: line.now!.Balance?.currency ?? line.now!.LowLimit.currency,
      issuer: line.now!.LowLimit.issuer === account ? line.now!.HighLimit.issuer : line.now!.LowLimit.issuer,
    });

    // §2.2: the pool's two assets.
    let assets: (PoolAsset | null)[] = [];
    if (amm) {
      for (const field of [amm.now!.Asset, amm.now!.Asset2]) {
        if (field === undefined || (field.issuer === undefined && field.mpt_issuance_id === undefined)) {
          assets.push({ currency: nativeCurrency, issuer: undefined });
        } else if (typeof field.issuer === 'string') {
          assets.push({ currency: field.currency, issuer: field.issuer });
        } else {
          assets.push(null);
        }
      }
    } else {
      for (const line of lines) {
        const a = lineAsset(line);
        if (!assets.some((b) => b && sameAsset(a, b))) assets.push(a);
      }
      const nonZero = (v: unknown) => v !== undefined && !new BigNumber(v as string).isZero();
      if (root && (nonZero(root.now!.Balance) || nonZero(root.was.Balance))) {
        assets.push({ currency: nativeCurrency, issuer: undefined });
      }
    }
    if (assets.length !== 2 || assets.includes(null) || sameAsset(assets[0]!, assets[1]!)) {
      result.unclassified += 1;
      continue;
    }
    let [base, counter] = assets as PoolAsset[];
    if (orderKey(counter) < orderKey(base)) [base, counter] = [counter, base];

    // The change and the after-value of one asset, as BigNumbers in whole units, or undefined after when no node holds it.
    const holding = (asset: PoolAsset): { change: BigNumber; after?: BigNumber; native: boolean } => {
      if (asset.issuer === undefined) {
        if (!root) return { change: new BigNumber(0), native: true };
        const after = new BigNumber(root.now!.Balance ?? 0);
        const before = root.op === 'CreatedNode' ? new BigNumber(0) : new BigNumber(root.was.Balance ?? after);
        return { change: after.minus(before), after, native: true };
      }
      const line = lines.find((l) => sameAsset(lineAsset(l), asset));
      if (!line) return { change: new BigNumber(0), native: false };
      const sign = ownSign(line);
      const after = new BigNumber(line.now!.Balance?.value ?? 0).times(sign);
      const before =
        line.op === 'CreatedNode'
          ? new BigNumber(0)
          : new BigNumber(line.was.Balance?.value ?? line.now!.Balance?.value ?? 0).times(sign);
      return { change: after.minus(before), after, native: false };
    };
    const text = (h: { native: boolean }, v: BigNumber) => (h.native ? fromDrops(v) : v.toString());
    const b = holding(base);
    const c = holding(counter);

    // §2.6: the state row.
    const state: Row = {
      amm_account: account,
      base_currency: base.currency,
      base_issuer: base.issuer ?? '',
      counter_currency: counter.currency,
      counter_issuer: counter.issuer ?? '',
    };
    if (b.after) state.reserve_base = text(b, b.after);
    if (c.after) state.reserve_counter = text(c, c.after);
    const deleted = amm?.op === 'DeletedNode' || root?.op === 'DeletedNode';
    if (amm) {
      const f = amm.now!;
      if (deleted) state.lp_supply = '0';
      else if (f.LPTokenBalance) state.lp_supply = new BigNumber(f.LPTokenBalance.value).toString();
      if (f.LPTokenBalance) state.lp_currency = f.LPTokenBalance.currency;
      state.trading_fee = f.TradingFee ?? 0;
      const slot = f.AuctionSlot;
      if (slot) {
        if (slot.Account !== undefined) state.auction_holder = slot.Account;
        if (slot.Price !== undefined) state.auction_price = new BigNumber(slot.Price.value).toString();
        state.auction_discounted_fee = slot.DiscountedFee ?? 0;
        if (slot.Expiration !== undefined) state.auction_expiration = slot.Expiration;
      }
    }
    state.deleted = deleted;
    result.states.push(state);

    // The LP-token change on the AMM node.
    const lpChange = (): BigNumber => {
      const now = new BigNumber(amm!.now!.LPTokenBalance?.value ?? 0);
      const was = amm!.was.LPTokenBalance ? new BigNumber(amm!.was.LPTokenBalance.value) : now;
      if (amm!.op === 'CreatedNode') return now;
      if (amm!.op === 'DeletedNode') return was.negated();
      return now.minus(was);
    };

    let classified = false;

    // §2.3: a swap.
    if (isSwapTx) {
      const bIn = b.change.isGreaterThan(0) && c.change.isLessThan(0);
      const cIn = c.change.isGreaterThan(0) && b.change.isLessThan(0);
      if (bIn || cIn) {
        const inAmount = new BigNumber(text(bIn ? b : c, (bIn ? b : c).change.abs()));
        const outAmount = new BigNumber(text(bIn ? c : b, (bIn ? c : b).change.abs()));
        const quality = inAmount.dividedBy(outAmount);
        // As for an order-book row whose offer owner is the pool: inverted when base is what the pool received.
        const rate = bIn ? new BigNumber(1).dividedBy(quality) : quality;
        const taker: string = tx.Account;
        const swap: Row = {
          amm_account: account,
          node_index: root ? root.index : lines[0].index,
          base_currency: base.currency,
          base_issuer: base.issuer ?? '',
          counter_currency: counter.currency,
          counter_issuer: counter.issuer ?? '',
          base_amount: text(b, b.change.abs()),
          counter_amount: text(c, c.change.abs()),
          rate: rate.toString(),
          buyer: bIn ? account : taker,
          seller: bIn ? taker : account,
          taker,
        };
        const issuedObject = (v: unknown) =>
          typeof v === 'object' && v !== null && typeof (v as Json).currency === 'string';
        if (
          tx.TransactionType === 'OfferCreate' &&
          issuedObject(tx.TakerPays) &&
          issuedObject(tx.TakerGets) &&
          (base.issuer === undefined) !== (counter.issuer === undefined)
        ) {
          const issued = base.issuer === undefined ? counter : base;
          const far =
            issued.currency === tx.TakerPays.currency
              ? tx.TakerGets
              : issued.currency === tx.TakerGets.currency
                ? tx.TakerPays
                : undefined;
          if (far) {
            swap.autobridged_currency = far.currency;
            swap.autobridged_issuer = far.issuer;
          }
        }
        result.swaps.push(swap);
        classified = true;
      }
    }

    // §2.4: a liquidity event.
    const event = EVENTS[tx.TransactionType];
    if (event && amm) {
      const row: Row = {
        amm_account: account,
        account: tx.TransactionType === 'AMMClawback' ? tx.Holder : tx.Account,
        initiator: tx.Account,
        event,
      };
      const modes = MODES[tx.TransactionType];
      if (modes) {
        const set = Object.keys(modes).filter((name) => ((tx.Flags ?? 0) & modes[name]) !== 0);
        if (set.length === 1) row.mode = set[0];
      }
      row.base_amount = text(b, b.change);
      row.counter_amount = text(c, c.change);
      row.lp_tokens = lpChange().toString();
      result.liquidity.push(row);
      classified = true;
    }

    // §2.5: a vote or a bid.
    if ((tx.TransactionType === 'AMMVote' || tx.TransactionType === 'AMMBid') && amm) {
      const f = amm.now!;
      const row: Row = {
        amm_account: account,
        kind: tx.TransactionType === 'AMMVote' ? 'vote' : 'bid',
        account: tx.Account,
      };
      if (tx.TransactionType === 'AMMVote') {
        if (tx.TradingFee !== undefined) row.fee_voted = tx.TradingFee;
        row.trading_fee_after = f.TradingFee ?? 0;
      } else {
        if (tx.BidMin !== undefined) row.bid_min = new BigNumber(tx.BidMin.value).toString();
        if (tx.BidMax !== undefined) row.bid_max = new BigNumber(tx.BidMax.value).toString();
        row.price_paid = lpChange().negated().toString();
        const slot = f.AuctionSlot;
        if (slot) {
          if (slot.Account !== undefined) row.slot_holder = slot.Account;
          row.slot_discounted_fee = slot.DiscountedFee ?? 0;
          if (slot.Expiration !== undefined) row.slot_expiration = slot.Expiration;
          row.auth_accounts = (slot.AuthAccounts ?? []).map((a: Json) => a.AuthAccount.Account);
        } else {
          row.auth_accounts = [];
        }
      }
      result.governance.push(row);
      classified = true;
    }

    if (!classified) result.unclassified += 1;
  }
  return result;
}
