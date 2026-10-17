/**
 * AmmParser over the recorded mainnet AMM cases (`test/fixtures/xrpl/amm`, README section "XRPL AMM cases") and the
 * synthetic cases below, each built from a recorded transaction by a small, named edit of its metadata:
 *
 * - `deposit_lp_token` (not found on mainnet): `deposit_two_asset` with `Flags` tfLPToken, `LPTokenOut` set to the LP
 *   tokens minted and no `Amount`/`Amount2`. A tfLPToken deposit moves both assets in proportion, so the metadata stays.
 * - `clawback` (not found): `withdraw_two_asset` (the RLUSD/USDC pool) turned into an `AMMClawback` by the RLUSD issuer
 *   with `Holder` the withdrawing LP: the issuer's AccountRoot pays the fee and the holder's RLUSD line is dropped (the
 *   clawed-back RLUSD goes to the issuer, which only shows on the pool's line); the USDC still goes to the holder.
 * - `delete` (not found): `withdraw_all_deletes_pool` turned into an `AMMDelete` of an already empty pool: the AMM node
 *   is deleted with `LPTokenBalance` 0, the pool AccountRoot and its trust lines are deleted with no balance change, the
 *   holder's SNK line is dropped and the sender's AccountRoot pays only the fee.
 * - `tec_*`: a recorded case with `TransactionResult` set to a `tec` code and every node kept.
 * - `swap_iou_iou_with_root`: `swap_iou_iou` plus the pool AccountRoot (Balance 0, unchanged) at the end.
 * - `swap_xrp_iou_without_root`: `swap_payment_xrp_iou` without the pool AccountRoot: only its lsfAMMNode line is left.
 * - `swap_xrp_iou_amm_node_without_root`: the same, with an unchanged AMM node of the pool added.
 * - `pool_lines_same_direction`: `swap_iou_iou` with the USDC pool line's change reversed, so both pool lines go up.
 * - `one_pool_line`: `swap_iou_iou` without its RLUSD pool line.
 * - `both_reserve_bits`: `swap_payment_xrp_iou` with lsfHighReserve also set on the pool line.
 * - `lines_without_reserve_bit`: `swap_iou_iou` with both pool lines' reserve bits cleared.
 * - `deposit_mpt_asset`: `deposit_two_asset` whose pool has an MPT as its second asset (`mpt_issuance_id` instead of an
 *   issuer).
 * - `swap_iou_iou_pool_high`: `swap_iou_iou` with both pool lines turned around, so that the pool is the HIGH account on
 *   both (LowLimit and HighLimit exchanged, lsfLowReserve replaced by lsfHighReserve, the balance negated): the same
 *   swap from the pool's side.
 * - `swap_iou_iou_same_issuer`: `swap_iou_iou` with the USDC lines issued by the RLUSD issuer, so that both assets of the
 *   pool have one issuer and only the currency tells them apart, and with the pool's USDC line turned around, so that
 *   the pool is the low account on the RLUSD line and the high one on the USDC line.
 * - `bid_exponent_form`, `create_exponent_form`: `bid` and `create` with LPTokenBalance, the auction price and BidMin and
 *   BidMax written as rippled writes large and small amounts (digits and an exponent, e.g. '294354152174e-9'): the
 *   same numbers.
 */
import { BigNumber } from 'bignumber.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ammOracle } from '../../test/amm-oracle';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { AmmParser, ParsedAmm, ParsedAmmSwap } from './amm.parser';
import { BalanceChangesParser } from './balance-changes.parser';
import { ExchangeParser } from './exchanges.parser';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';

type Json = Record<string, any>;

const DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'xrpl', 'amm');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
  cases: Record<string, { ledger: number; hash: string }>;
};
const source = FixtureLedgerSource.fromDir(DIR);

const XRPL: ParseContext = parseContextFor(getNetworkProfile('xrpl'));
const XAHAU: ParseContext = parseContextFor(getNetworkProfile('xahau'));

const LSF_AMM_NODE = 0x01000000;
const LSF_LOW_RESERVE = 0x00010000;
const LSF_HIGH_RESERVE = 0x00020000;

// Pools and accounts of the recorded cases.
const XRP_RLUSD = 'rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3';
const RLUSD_USDC = 'rfWfhoLj3LiaBpoxus3h7pEF8jXDMtyGqb';
const XRP_USD_GATEHUB = 'rs9ineLqrCzeAGS1bxsrW8x2n3bRJYAh3Q';
const XRP_SGB = 'rEaErQ5vEbHXThFedUrjz9YFotG5HHcxoW';
const XRP_SNK = 'rGLnUKdptCVobJKEkrwxtdyGZ98Evdmqdz';
const XRP_VOX = 'rhEypxvxNXMdMTd3GXpb6gTN1jvb4h3nef';
const XRP_USD_BITSTAMP = 'rHUpaqUPbwzKZdzQ8ZQCme18FrgW9pB4am';
const XRP_DVR = 'rUAEvY1XNvnkurE9RunV7u3yjh3jQsQPsG';
const RLUSD = { currency: '524C555344000000000000000000000000000000', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' };
const USDC = { currency: '5553444300000000000000000000000000000000', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' };
const GATEHUB_USD = { currency: 'USD', issuer: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq' };
const SGB = { currency: 'SGB', issuer: 'rctArjqVvTHihekzDeecKo6mkTYTUSBNc' };
const SNK = { currency: 'SNK', issuer: 'rDDYXY17rzuF44gVAAQ9MB6GRQFkvWSccm' };
const VOX = { currency: '564F58F09F97BD00000000000000000000000000', issuer: 'rBnJZMDB9HZ6UxUoeQc7eaAQHA3Y1v6Hk3' };
const BITSTAMP_USD = { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' };
const DVR = { currency: 'DVR', issuer: 'rpvRJUcmqQqyCHCmYRPW9FXFAGQEcibVz9' };
const XAH_GATEHUB = { currency: 'XAH', issuer: 'rswh1fvyLqHizBS2awu1vs6QcmwTBd9qiv' };

const parser = new AmmParser();
const exchangeParser = new ExchangeParser();
const balanceChangesParser = new BalanceChangesParser();

/** A recorded case by its manifest name, deep-frozen. */
async function recorded(name: string): Promise<ParserTx> {
  const c = manifest.cases[name];
  if (!c) throw new Error(`no recorded case ${name}`);
  const ledger = await source.fetch(c.ledger);
  const raw = ledger.transactions.find((t) => t.hash === c.hash);
  if (!raw) throw new Error(`${name}: ${c.hash} is not in ledger ${c.ledger}`);
  return deepFreeze(toParserTx(raw, ledger.header, null));
}

/** A deep-frozen copy of `t` after `edit` changed (copies of) its transaction and metadata. */
function variant(t: ParserTx, edit: (tx: Json, meta: Json) => void): ParserTx {
  const tx = structuredClone(t.tx) as Json;
  const meta = structuredClone(t.meta) as Json;
  edit(tx, meta);
  return deepFreeze({ ...t, tx, meta });
}

/** The body (`ModifiedNode`, ... contents) of `AffectedNodes[index]`. */
const body = (meta: Json, index: number): Json => {
  const wrapper = meta.AffectedNodes[index];
  return wrapper[Object.keys(wrapper)[0]];
};

/** The same number as `value`, written as rippled writes large and small amounts: the digits and an exponent. */
function exponentForm(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${BigInt(whole + fraction)}e${-fraction.length}`;
}

/** `t` with every amount the AMM parser passes on (LPTokenBalance, auction price, BidMin, BidMax) in exponent form. */
function inExponentForm(t: ParserTx): ParserTx {
  return variant(t, (tx, meta) => {
    const rewrite = (amount: Json | undefined) => {
      if (amount) amount.value = exponentForm(amount.value);
    };
    rewrite(tx.BidMin);
    rewrite(tx.BidMax);
    for (const wrapper of meta.AffectedNodes as Json[]) {
      const node = Object.values(wrapper)[0] as Json;
      if (node.LedgerEntryType !== 'AMM') continue;
      for (const fields of [node.NewFields, node.FinalFields, node.PreviousFields]) {
        rewrite(fields?.LPTokenBalance);
        rewrite(fields?.AuctionSlot?.Price);
      }
    }
  });
}

/** The body of the (first) AMM node of the metadata. */
const ammBody = (meta: Json): Json =>
  meta.AffectedNodes.map((w: Json) => Object.values(w)[0]).find((n: Json) => n.LedgerEntryType === 'AMM');

/** A trust line of the pool as the low account turned around: the pool is the high account, the balance is negated. */
function poolToHighSide(line: Json): void {
  for (const fields of [line.FinalFields, line.PreviousFields]) {
    if (fields.Balance) fields.Balance.value = new BigNumber(fields.Balance.value).negated().toString();
  }
  const final = line.FinalFields;
  [final.LowLimit, final.HighLimit] = [final.HighLimit, final.LowLimit];
  [final.LowNode, final.HighNode] = [final.HighNode, final.LowNode];
  final.Flags = LSF_AMM_NODE | LSF_HIGH_RESERVE;
}

const synthetic: Record<string, (r: (name: string) => Promise<ParserTx>) => Promise<ParserTx>> = {
  bid_exponent_form: async (r) => inExponentForm(await r('bid')),
  create_exponent_form: async (r) => inExponentForm(await r('create')),
  deposit_mpt_asset: async (r) =>
    variant(await r('deposit_two_asset'), (_tx, meta) => {
      ammBody(meta).FinalFields.Asset2 = { mpt_issuance_id: '0000012FFD9EE5DA93AC614B4DB94D7E0FCE415CA51BED47' };
    }),
  swap_iou_iou_pool_high: async (r) =>
    variant(await r('swap_iou_iou'), (_tx, meta) => {
      // Nodes 1 and 2 are the pool's lines, with the pool as the low account.
      for (const index of [1, 2]) poolToHighSide(body(meta, index));
    }),
  swap_iou_iou_same_issuer: async (r) =>
    variant(await r('swap_iou_iou'), (_tx, meta) => {
      // Nodes 0 (the taker's line) and 1 (the pool's) are the USDC ones: their issuer becomes the RLUSD issuer. The
      // pool's USDC line is turned around too, so that the pool is the high account on it and the low one on the
      // RLUSD line: two lines with the same issuer and the pool on different sides.
      for (const index of [0, 1]) body(meta, index).FinalFields.HighLimit.issuer = RLUSD.issuer;
      poolToHighSide(body(meta, 1));
    }),
  deposit_lp_token: async (r) =>
    variant(await r('deposit_two_asset'), (tx) => {
      tx.Flags = 0x00010000;
      delete tx.Amount;
      delete tx.Amount2;
      tx.LPTokenOut = {
        currency: '03B245BE580EC4F4386A751C084489EC4B514A2F',
        issuer: XRP_RLUSD,
        value: '80142.926261',
      };
    }),
  clawback: async (r) =>
    variant(await r('withdraw_two_asset'), (tx, meta) => {
      tx.TransactionType = 'AMMClawback';
      tx.Holder = tx.Account;
      tx.Account = RLUSD.issuer;
      tx.Asset = { ...RLUSD };
      tx.Asset2 = { ...USDC };
      tx.Amount = { ...RLUSD, value: '4.180497018219' };
      tx.Flags = 0;
      delete tx.Amount2;
      body(meta, 0).FinalFields.Account = RLUSD.issuer;
      meta.AffectedNodes.splice(4, 1);
    }),
  delete: async (r) =>
    variant(await r('withdraw_all_deletes_pool'), (tx, meta) => {
      tx.TransactionType = 'AMMDelete';
      tx.Flags = 0;
      body(meta, 0).PreviousFields = { OwnerCount: 1 };
      body(meta, 3).PreviousFields = { Flags: 16908288 };
      body(meta, 4).PreviousFields = { Flags: 2228224 };
      Object.assign(body(meta, 5), {
        FinalFields: { ...body(meta, 5).FinalFields, Balance: '13958931' },
        PreviousFields: { Balance: '13958943', OwnerCount: 10, Sequence: 90648515 },
      });
      body(meta, 7).FinalFields.LPTokenBalance.value = '0';
      meta.AffectedNodes.splice(1, 1);
    }),
  tec_swap: async (r) =>
    variant(await r('swap_payment_xrp_iou'), (_tx, meta) => {
      meta.TransactionResult = 'tecPATH_PARTIAL';
    }),
  tec_deposit: async (r) =>
    variant(await r('deposit_two_asset'), (_tx, meta) => {
      meta.TransactionResult = 'tecAMM_FAILED';
    }),
  tec_bid: async (r) =>
    variant(await r('bid'), (_tx, meta) => {
      meta.TransactionResult = 'tecAMM_INVALID_TOKENS';
    }),
  swap_iou_iou_with_root: async (r) =>
    variant(await r('swap_iou_iou'), (_tx, meta) => {
      meta.AffectedNodes.push({
        ModifiedNode: {
          LedgerEntryType: 'AccountRoot',
          FinalFields: {
            AMMID: 'AB'.repeat(32),
            Account: RLUSD_USDC,
            Balance: '0',
            Flags: 26214400,
            OwnerCount: 1,
            Sequence: 1,
          },
        },
      });
    }),
  swap_xrp_iou_without_root: async (r) =>
    variant(await r('swap_payment_xrp_iou'), (_tx, meta) => {
      meta.AffectedNodes.splice(1, 1);
    }),
  swap_xrp_iou_amm_node_without_root: async (r) => {
    const amm = body((await r('deposit_two_asset')).meta, 0).FinalFields;
    return variant(await r('swap_payment_xrp_iou'), (_tx, meta) => {
      meta.AffectedNodes.splice(1, 1, { ModifiedNode: { LedgerEntryType: 'AMM', FinalFields: structuredClone(amm) } });
    });
  },
  pool_lines_same_direction: async (r) =>
    variant(await r('swap_iou_iou'), (_tx, meta) => {
      const usdcLine = body(meta, 1);
      [usdcLine.FinalFields.Balance, usdcLine.PreviousFields.Balance] = [
        usdcLine.PreviousFields.Balance,
        usdcLine.FinalFields.Balance,
      ];
    }),
  one_pool_line: async (r) =>
    variant(await r('swap_iou_iou'), (_tx, meta) => {
      meta.AffectedNodes.splice(2, 1);
    }),
  both_reserve_bits: async (r) =>
    variant(await r('swap_payment_xrp_iou'), (_tx, meta) => {
      body(meta, 0).FinalFields.Flags |= LSF_HIGH_RESERVE;
    }),
  lines_without_reserve_bit: async (r) =>
    variant(await r('swap_iou_iou'), (_tx, meta) => {
      body(meta, 1).FinalFields.Flags = LSF_AMM_NODE;
      body(meta, 2).FinalFields.Flags = LSF_AMM_NODE;
    }),
};

async function caseTx(name: string): Promise<ParserTx> {
  return synthetic[name] ? synthetic[name](recorded) : recorded(name);
}

const RECORDED = Object.keys(manifest.cases);
const ALL = [...RECORDED, ...Object.keys(synthetic)];

const EMPTY: ParsedAmm = { swaps: [], states: [], liquidity: [], governance: [], unclassified: 0 };

/** The change of `LPTokenBalance` on the pool's AMM node: + minted, - burned, the whole balance burned on deletion. */
function lpTokenBalanceChange(t: ParserTx, pool: string): BigNumber {
  const node = (t.meta.AffectedNodes as Json[])
    .map((w) => ({ op: Object.keys(w)[0], b: w[Object.keys(w)[0]] }))
    .find((n) => n.b.LedgerEntryType === 'AMM' && (n.b.NewFields ?? n.b.FinalFields).Account === pool) as Json;
  const now = new BigNumber((node.b.NewFields ?? node.b.FinalFields).LPTokenBalance.value);
  const was = node.b.PreviousFields?.LPTokenBalance ? new BigNumber(node.b.PreviousFields.LPTokenBalance.value) : now;
  if (node.op === 'CreatedNode') return now;
  if (node.op === 'DeletedNode') return was.negated();
  return now.minus(was);
}

/**
 * The change of the pool's holding of one asset as `BalanceChangesParser` sees it (pool accounts are ordinary accounts
 * there, ruling R14): an independent way to the pool deltas.
 */
function poolBalanceChange(t: ParserTx, pool: string, currency: string, issuer: string): BigNumber {
  return balanceChangesParser
    .parse(t, XRPL)
    .filter((c) => c.account === pool && c.counterparty === issuer && c.currency === currency)
    .reduce((sum, c) => sum.plus(c.amount_change), new BigNumber(0));
}

/** The LP tokens holders gained (+) or lost (-) on their lines with the pool, from `BalanceChangesParser`. */
function holderLpChange(t: ParserTx, pool: string, lpCurrency: string): BigNumber {
  return balanceChangesParser
    .parse(t, XRPL)
    .filter((c) => c.account !== pool && c.counterparty === pool && c.currency === lpCurrency)
    .reduce((sum, c) => sum.plus(c.amount_change), new BigNumber(0));
}

/** The swap as an order-book offer owned by the pool, run through ExchangeParser: what it would make of the amounts. */
function asBookExchange(t: ParserTx, swap: ParsedAmmSwap) {
  const baseOut = swap.buyer === swap.taker;
  const side = (currency: string, issuer: string, amount: string) =>
    issuer === '' ? new BigNumber(amount).shiftedBy(6).toFixed() : { currency, issuer, value: amount };
  const zero = (currency: string, issuer: string) => (issuer === '' ? '0' : { currency, issuer, value: '0' });
  const base = [swap.base_currency, swap.base_issuer] as const;
  const counter = [swap.counter_currency, swap.counter_issuer] as const;
  // The owner receives TakerPays and pays TakerGets.
  const [received, receivedAmount, paid, paidAmount] = baseOut
    ? [counter, swap.counter_amount, base, swap.base_amount]
    : [base, swap.base_amount, counter, swap.counter_amount];
  const offer = {
    ModifiedNode: {
      LedgerEntryType: 'Offer',
      FinalFields: {
        Account: swap.amm_account,
        BookDirectory: 'no book directory',
        Sequence: 0,
        TakerPays: zero(...received),
        TakerGets: zero(...paid),
      },
      PreviousFields: { TakerPays: side(...received, receivedAmount), TakerGets: side(...paid, paidAmount) },
    },
  };
  const [row] = exchangeParser.parse({ ...t, meta: { ...t.meta, AffectedNodes: [offer] } }, XRPL);
  return row;
}

describe('AmmParser', () => {
  describe('swaps', () => {
    it('swap_payment_xrp_iou: one swap with the pool deltas, the pool as seller of base, the AccountRoot node', async () => {
      const result = parser.parse(await recorded('swap_payment_xrp_iou'), XRPL);
      expect(result.swaps).toStrictEqual([
        {
          amm_account: XRP_RLUSD,
          node_index: 1,
          base_currency: RLUSD.currency,
          base_issuer: RLUSD.issuer,
          counter_currency: 'XRP',
          counter_issuer: '',
          base_amount: '179.448166793',
          counter_amount: '134',
          rate: new BigNumber('134').dividedBy('179.448166793').toString(),
          buyer: 'rMsrQGK9fZ6B2164QGLnjLMxBYSCY5xJ4W',
          seller: XRP_RLUSD,
          taker: 'rMsrQGK9fZ6B2164QGLnjLMxBYSCY5xJ4W',
        },
      ]);
      expect(result.unclassified).toBe(0);
    });

    it('swap_offercreate_xrp_iou: base flowed into the pool, so the pool is the buyer', async () => {
      const [swap] = parser.parse(await recorded('swap_offercreate_xrp_iou'), XRPL).swaps;
      expect(swap).toMatchObject({
        amm_account: XRP_RLUSD,
        node_index: 3,
        base_currency: RLUSD.currency,
        counter_currency: 'XRP',
        base_amount: '543.870850376',
        counter_amount: '417.277515',
        rate: new BigNumber('543.870850376').dividedBy('417.277515').pow(-1).toString(),
        buyer: XRP_RLUSD,
        seller: 'rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy',
        taker: 'rKYdJJLAgxbJcn9Ria2X5jMMiqP91r4qy',
      });
      expect(swap).not.toHaveProperty('autobridged_currency');
    });

    it('swap_iou_iou: found from the two lsfAMMNode lines alone, node_index the first of them', async () => {
      const result = parser.parse(await recorded('swap_iou_iou'), XRPL);
      expect(result.swaps).toStrictEqual([
        {
          amm_account: RLUSD_USDC,
          node_index: 1,
          base_currency: RLUSD.currency,
          base_issuer: RLUSD.issuer,
          counter_currency: USDC.currency,
          counter_issuer: USDC.issuer,
          base_amount: '22.19651885465',
          counter_amount: '22.21468168488',
          rate: new BigNumber('22.19651885465').dividedBy('22.21468168488').pow(-1).toString(),
          buyer: RLUSD_USDC,
          seller: 'rogue5HnPRSszD9CWGSUz8UGHMVwSSKF6',
          taker: 'rogue5HnPRSszD9CWGSUz8UGHMVwSSKF6',
        },
      ]);
      expect(result.unclassified).toBe(0);
    });

    it('swap_iou_iou with the pool AccountRoot present: the same swap, at the AccountRoot node', async () => {
      const without = parser.parse(await recorded('swap_iou_iou'), XRPL);
      const withRoot = parser.parse(await caseTx('swap_iou_iou_with_root'), XRPL);
      expect(withRoot.swaps).toStrictEqual([{ ...without.swaps[0], node_index: 5 }]);
      // The AccountRoot of an IOU/IOU pool holds no XRP, so XRP is not one of its assets.
      expect(withRoot.states).toStrictEqual(without.states);
    });

    it('swap_iou_iou with the pool as the HIGH account on both lines: the same swap, the sign flipped back', async () => {
      const t = await caseTx('swap_iou_iou_pool_high');
      const lines = (t.meta.AffectedNodes as Json[]).slice(1, 3).map((w) => w.ModifiedNode.FinalFields);
      for (const line of lines) {
        expect(line.HighLimit.issuer).toBe(RLUSD_USDC);
        expect(Number(line.Balance.value)).toBeLessThan(0);
      }
      const plain = parser.parse(await recorded('swap_iou_iou'), XRPL);
      expect(plain.swaps).toHaveLength(1);
      expect(parser.parse(t, XRPL)).toStrictEqual(plain);
    });

    it('swap_iou_iou with one issuer for both assets and the pool on different sides: the reserve bit names the pool on both lines', async () => {
      const t = await caseTx('swap_iou_iou_same_issuer');
      const [usdc, rlusd] = (t.meta.AffectedNodes as Json[]).slice(1, 3).map((w) => w.ModifiedNode.FinalFields);
      expect([usdc.HighLimit.issuer, usdc.LowLimit.issuer]).toEqual([RLUSD_USDC, RLUSD.issuer]);
      expect([rlusd.LowLimit.issuer, rlusd.HighLimit.issuer]).toEqual([RLUSD_USDC, RLUSD.issuer]);
      const plain = parser.parse(await recorded('swap_iou_iou'), XRPL);
      const result = parser.parse(t, XRPL);
      expect(result.unclassified).toBe(0);
      expect(result.swaps).toStrictEqual([{ ...plain.swaps[0], counter_issuer: RLUSD.issuer }]);
      expect(result.states).toStrictEqual([{ ...plain.states[0], counter_issuer: RLUSD.issuer }]);
      expect(result.swaps[0].base_issuer).toBe(result.swaps[0].counter_issuer);
    });

    it('payment_two_pools: one swap per pool, each at its own AccountRoot', async () => {
      const result = parser.parse(await recorded('payment_two_pools'), XRPL);
      const taker = 'rNEpRusKEXTqTpJiGYNi3xrmDBLnT5BUPC';
      expect(result.swaps).toStrictEqual([
        {
          amm_account: XRP_SGB,
          node_index: 0,
          base_currency: SGB.currency,
          base_issuer: SGB.issuer,
          counter_currency: 'XRP',
          counter_issuer: '',
          base_amount: '2213.26267826',
          counter_amount: '1.455815',
          rate: new BigNumber('1.455815').dividedBy('2213.26267826').toString(),
          buyer: taker,
          seller: XRP_SGB,
          taker,
        },
        {
          amm_account: XRP_USD_GATEHUB,
          node_index: 5,
          base_currency: 'USD',
          base_issuer: GATEHUB_USD.issuer,
          counter_currency: 'XRP',
          counter_issuer: '',
          base_amount: '2.04637079847',
          counter_amount: '1.455815',
          rate: new BigNumber('2.04637079847').dividedBy('1.455815').pow(-1).toString(),
          buyer: XRP_USD_GATEHUB,
          seller: taker,
          taker,
        },
      ]);
      expect(result.states.map((s) => s.amm_account)).toEqual([XRP_SGB, XRP_USD_GATEHUB]);
    });

    it('payment_pool_and_book: one AMM swap; ExchangeParser still gives the book row, at another node', async () => {
      const t = await recorded('payment_pool_and_book');
      const result = parser.parse(t, XRPL);
      expect(result.swaps).toHaveLength(1);
      expect(result.swaps[0]).toMatchObject({
        amm_account: XRP_RLUSD,
        node_index: 5,
        base_amount: '1.325962092',
        counter_amount: '1.015604',
        buyer: 'rfi8FjRARhrHfFgtphVNYEoWRzx4MhKGnZ',
        seller: XRP_RLUSD,
      });
      const book = exchangeParser.parse(t, XRPL);
      expect(book).toHaveLength(1);
      expect(book[0]).toMatchObject({
        provider: 'rKrVTQChbm1761udZt18u9Aq9onJwEyvZw',
        node_index: 6,
        base_currency: RLUSD.currency,
        base_amount: '1.664037908479139',
        counter_amount: '1.27451',
        offer_sequence: 107195225,
      });
    });

    it('offercreate_autobridged_pool_leg: the pool leg is autobridged to the far side, like the book leg', async () => {
      const t = await recorded('offercreate_autobridged_pool_leg');
      const result = parser.parse(t, XRPL);
      expect(result.swaps).toHaveLength(1);
      expect(result.swaps[0]).toMatchObject({
        amm_account: XRP_RLUSD,
        node_index: 7,
        base_currency: RLUSD.currency,
        base_amount: '1',
        counter_amount: '0.766153',
        buyer: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
        seller: XRP_RLUSD,
        autobridged_currency: XAH_GATEHUB.currency,
        autobridged_issuer: XAH_GATEHUB.issuer,
      });
      const [book] = exchangeParser.parse(t, XRPL);
      expect(book).toMatchObject({ autobridged_currency: RLUSD.currency, autobridged_issuer: RLUSD.issuer });
    });

    it("swap_issuer_transfer_rate: the amounts are the pool's deltas, not what the receiver got", async () => {
      const [swap] = parser.parse(await recorded('swap_issuer_transfer_rate'), XRPL).swaps;
      expect(swap).toMatchObject({
        amm_account: XRP_USD_GATEHUB,
        base_currency: 'USD',
        base_issuer: GATEHUB_USD.issuer,
        base_amount: '83.28354047857',
        counter_amount: '54.514846',
      });
    });

    it('both reserve bits set: the pool side comes from the pool AccountRoot, and the swap is unchanged', async () => {
      const plain = parser.parse(await recorded('swap_payment_xrp_iou'), XRPL);
      expect(parser.parse(await caseTx('both_reserve_bits'), XRPL)).toStrictEqual(plain);
    });

    it('the native currency is the context one', async () => {
      const [swap] = parser.parse(await recorded('swap_payment_xrp_iou'), XAHAU).swaps;
      expect(swap).toMatchObject({ counter_currency: 'XAH', counter_issuer: '' });
    });
  });

  describe('pools that do not make a swap', () => {
    it('lsfAMMNode lines alone that both go up: a state row, no swap, unclassified 1', async () => {
      const result = parser.parse(await caseTx('pool_lines_same_direction'), XRPL);
      expect(result.swaps).toEqual([]);
      expect(result.unclassified).toBe(1);
      expect(result.states).toStrictEqual([
        {
          amm_account: RLUSD_USDC,
          base_currency: RLUSD.currency,
          base_issuer: RLUSD.issuer,
          counter_currency: USDC.currency,
          counter_issuer: USDC.issuer,
          reserve_base: '26106.99384217401',
          reserve_counter: '26166.00356770683',
          deleted: false,
        },
      ]);
    });

    it('one lsfAMMNode line, no AccountRoot and no AMM node: the pair is unknown, so no rows and unclassified 1', async () => {
      expect(parser.parse(await caseTx('one_pool_line'), XRPL)).toStrictEqual({ ...EMPTY, unclassified: 1 });
      expect(parser.parse(await caseTx('swap_xrp_iou_without_root'), XRPL)).toStrictEqual({
        ...EMPTY,
        unclassified: 1,
      });
    });

    it('an AMM node but no pool AccountRoot in an XRP/IOU swap: only one asset moved, so a state row and unclassified 1', async () => {
      const result = parser.parse(await caseTx('swap_xrp_iou_amm_node_without_root'), XRPL);
      expect(result.swaps).toEqual([]);
      expect(result.unclassified).toBe(1);
      expect(result.states).toHaveLength(1);
      expect(result.states[0]).toMatchObject({ amm_account: XRP_RLUSD, reserve_base: '2447341.562339902' });
      expect(result.states[0]).not.toHaveProperty('reserve_counter');
    });

    it('lsfAMMNode lines with no reserve bit and no AccountRoot or AMM node: no pool, each line unclassified', async () => {
      expect(parser.parse(await caseTx('lines_without_reserve_bit'), XRPL)).toStrictEqual({
        ...EMPTY,
        unclassified: 2,
      });
    });

    it('a pool with an MPT asset is unclassified: no rows, counted once', async () => {
      expect(parser.parse(await caseTx('deposit_mpt_asset'), XRPL)).toStrictEqual({ ...EMPTY, unclassified: 1 });
    });

    it('lp_token_transfer: LP-token lines alone touch no pool', async () => {
      expect(parser.parse(await recorded('lp_token_transfer'), XRPL)).toStrictEqual(EMPTY);
    });

    it.each(['tec_swap', 'tec_deposit', 'tec_bid'])('%s: a failed transaction gives no rows at all', async (name) => {
      expect(parser.parse(await caseTx(name), XRPL)).toStrictEqual(EMPTY);
    });
  });

  describe('liquidity events', () => {
    it('deposit_two_asset: the signed pool deltas, the LPTokenBalance change and mode two_asset', async () => {
      const result = parser.parse(await recorded('deposit_two_asset'), XRPL);
      expect(result.liquidity).toStrictEqual([
        {
          amm_account: XRP_RLUSD,
          account: 'rfzppK1YerX4U8Utr2kVvBuVPLF3m4Yu3z',
          initiator: 'rfzppK1YerX4U8Utr2kVvBuVPLF3m4Yu3z',
          event: 'deposit',
          mode: 'two_asset',
          base_amount: '108.041216585',
          counter_amount: '82.769304',
          lp_tokens: '80142.926261',
        },
      ]);
      expect(result.swaps).toEqual([]);
      expect(result.unclassified).toBe(0);
    });

    it('deposit_single_asset: the RLUSD side did not move', async () => {
      expect(parser.parse(await recorded('deposit_single_asset'), XRPL).liquidity).toStrictEqual([
        {
          amm_account: XRP_RLUSD,
          account: 'rPcANyJoYnZvNP85sJZZzoXiB9Ux2gF3f',
          initiator: 'rPcANyJoYnZvNP85sJZZzoXiB9Ux2gF3f',
          event: 'deposit',
          mode: 'single_asset',
          base_amount: '0',
          counter_amount: '1010',
          lp_tokens: '489501.888267',
        },
      ]);
    });

    it('deposit_lp_token (synthetic): mode lp_token', async () => {
      const [row] = parser.parse(await caseTx('deposit_lp_token'), XRPL).liquidity;
      expect(row).toMatchObject({ event: 'deposit', mode: 'lp_token', lp_tokens: '80142.926261' });
    });

    it('withdraw_two_asset (IOU/IOU pool, no AccountRoot): both sides out, LP tokens burned', async () => {
      expect(parser.parse(await recorded('withdraw_two_asset'), XRPL).liquidity).toStrictEqual([
        {
          amm_account: RLUSD_USDC,
          account: 'rwzSeSjHXGjTPbB5NQuqWsQnpT7Jm3rAqV',
          initiator: 'rwzSeSjHXGjTPbB5NQuqWsQnpT7Jm3rAqV',
          event: 'withdraw',
          mode: 'two_asset',
          base_amount: '-4.18049701822',
          counter_amount: '-4.17981839135',
          lp_tokens: '-4.16712896228',
        },
      ]);
    });

    it('withdraw_single_asset: XRP out, LP tokens burned', async () => {
      const [row] = parser.parse(await recorded('withdraw_single_asset'), XRPL).liquidity;
      expect(row).toMatchObject({
        mode: 'single_asset',
        base_amount: '0',
        counter_amount: '-49.999999',
        lp_tokens: '-24262.103601',
      });
    });

    it('withdraw_all_deletes_pool: a withdraw event and a deleted state row', async () => {
      const result = parser.parse(await recorded('withdraw_all_deletes_pool'), XRPL);
      expect(result.liquidity).toStrictEqual([
        {
          amm_account: XRP_SNK,
          account: 'rHjzfruAe7qbEPjzvdfQ4zvjoZnQHcomwP',
          initiator: 'rHjzfruAe7qbEPjzvdfQ4zvjoZnQHcomwP',
          event: 'withdraw',
          mode: 'withdraw_all',
          base_amount: '-0.0000851206393053295',
          counter_amount: '-0.021974',
          lp_tokens: '-1.18871683962',
        },
      ]);
      expect(result.states).toStrictEqual([
        {
          amm_account: XRP_SNK,
          base_currency: SNK.currency,
          base_issuer: SNK.issuer,
          counter_currency: 'XRP',
          counter_issuer: '',
          reserve_base: '0',
          reserve_counter: '0',
          lp_supply: '0',
          lp_currency: '03BEE087CAB9A53DE035A3E3F7550EEC26048A1B',
          trading_fee: 250,
          auction_holder: 'rJxRjYD2ic9D56gJhsc2v5ZgSZ8JdJqEEG',
          auction_price: '0',
          auction_discounted_fee: 25,
          auction_expiration: 809017710,
          deleted: true,
        },
      ]);
    });

    it('clawback (synthetic): account is the Holder, initiator the issuer, no mode', async () => {
      const result = parser.parse(await caseTx('clawback'), XRPL);
      expect(result.liquidity).toStrictEqual([
        {
          amm_account: RLUSD_USDC,
          account: 'rwzSeSjHXGjTPbB5NQuqWsQnpT7Jm3rAqV',
          initiator: RLUSD.issuer,
          event: 'clawback',
          base_amount: '-4.18049701822',
          counter_amount: '-4.17981839135',
          lp_tokens: '-4.16712896228',
        },
      ]);
    });

    it('create: a create event with the initial reserves and LP supply, and a full state row', async () => {
      const result = parser.parse(await recorded('create'), XRPL);
      const creator = 'rEh4WnsrdmE7V1XeTsWi5dM7FHH8hYuea3';
      expect(result.liquidity).toStrictEqual([
        {
          amm_account: XRP_DVR,
          account: creator,
          initiator: creator,
          event: 'create',
          base_amount: '1000000',
          counter_amount: '500',
          lp_tokens: '22360679.77499789',
        },
      ]);
      expect(result.states).toStrictEqual([
        {
          amm_account: XRP_DVR,
          base_currency: DVR.currency,
          base_issuer: DVR.issuer,
          counter_currency: 'XRP',
          counter_issuer: '',
          reserve_base: '1000000',
          reserve_counter: '500',
          lp_supply: '22360679.77499789',
          lp_currency: '036D9072B9D0C769D60E61FCC2E38D12E1C6BD27',
          trading_fee: 1000,
          auction_holder: creator,
          auction_price: '0',
          auction_discounted_fee: 100,
          auction_expiration: 845235400,
          deleted: false,
        },
      ]);
    });

    it('delete (synthetic): a delete event of nothing, and a deleted state row', async () => {
      const result = parser.parse(await caseTx('delete'), XRPL);
      expect(result.liquidity).toStrictEqual([
        {
          amm_account: XRP_SNK,
          account: 'rHjzfruAe7qbEPjzvdfQ4zvjoZnQHcomwP',
          initiator: 'rHjzfruAe7qbEPjzvdfQ4zvjoZnQHcomwP',
          event: 'delete',
          base_amount: '0',
          counter_amount: '0',
          lp_tokens: '0',
        },
      ]);
      expect(result.states).toHaveLength(1);
      expect(result.states[0]).toMatchObject({
        reserve_base: '0',
        reserve_counter: '0',
        lp_supply: '0',
        deleted: true,
      });
    });

    describe('mode follows the flags', () => {
      const deposit: [number, string][] = [
        [0x00010000, 'lp_token'],
        [0x00080000, 'single_asset'],
        [0x00100000, 'two_asset'],
        [0x00200000, 'one_asset_lp_token'],
        [0x00400000, 'limit_lp_token'],
        [0x00800000, 'two_asset_if_empty'],
      ];
      const withdraw: [number, string][] = [
        [0x00010000, 'lp_token'],
        [0x00020000, 'withdraw_all'],
        [0x00040000, 'one_asset_withdraw_all'],
        [0x00080000, 'single_asset'],
        [0x00100000, 'two_asset'],
        [0x00200000, 'one_asset_lp_token'],
        [0x00400000, 'limit_lp_token'],
      ];
      const withFlags = async (name: string, flags: number) =>
        parser.parse(
          variant(await recorded(name), (tx) => (tx.Flags = flags)),
          XRPL,
        ).liquidity[0];

      it.each(deposit)('AMMDeposit flag %i gives %s, next to tfFullyCanonicalSig', async (flag, mode) => {
        expect((await withFlags('deposit_two_asset', (flag | 0x80000000) >>> 0)).mode).toBe(mode);
      });

      it.each(withdraw)('AMMWithdraw flag %i gives %s', async (flag, mode) => {
        expect((await withFlags('withdraw_two_asset', flag)).mode).toBe(mode);
      });

      it('no mode flag, two mode flags, or a withdraw-only flag on a deposit: no mode', async () => {
        expect(await withFlags('deposit_two_asset', 0)).not.toHaveProperty('mode');
        expect(await withFlags('deposit_two_asset', 0x00180000)).not.toHaveProperty('mode');
        expect(await withFlags('deposit_two_asset', 0x00020000)).not.toHaveProperty('mode');
        expect(await withFlags('withdraw_two_asset', 0x00800000)).not.toHaveProperty('mode');
      });
    });
  });

  describe('governance', () => {
    it('vote: the voter, the fee voted and the trading fee after', async () => {
      const result = parser.parse(await recorded('vote'), XRPL);
      expect(result.governance).toStrictEqual([
        {
          amm_account: XRP_VOX,
          kind: 'vote',
          account: 'rthwVkuErKQtat6Sn6X2vAeveCEWfFBnt',
          fee_voted: 1000,
          trading_fee_after: 1000,
        },
      ]);
      expect(result.states).toStrictEqual([
        {
          amm_account: XRP_VOX,
          base_currency: VOX.currency,
          base_issuer: VOX.issuer,
          counter_currency: 'XRP',
          counter_issuer: '',
          lp_supply: '7881180.64345377',
          lp_currency: '03BAEDE9870DA0FC0B480B45E46AABB97B8EB931',
          trading_fee: 1000,
          auction_holder: 'rKHM6vJYeVFqBvmj8VKRkdFY9ygkLRHWgZ',
          auction_price: '0',
          auction_discounted_fee: 100,
          auction_expiration: 845211390,
          deleted: false,
        },
      ]);
      expect(result.liquidity).toEqual([]);
      expect(result.unclassified).toBe(0);
    });

    it('bid: the bid range, the LP tokens burned as price_paid and the new slot', async () => {
      const t = await recorded('bid');
      const result = parser.parse(t, XRPL);
      const bidder = 'r4S6hRiKREKkmMeqs8dpgyYAotGyck9g3h';
      expect(result.governance).toStrictEqual([
        {
          amm_account: XRP_USD_BITSTAMP,
          kind: 'bid',
          account: bidder,
          bid_min: '294.354152174',
          bid_max: '294.354152174',
          price_paid: '294.354152174',
          slot_holder: bidder,
          slot_discounted_fee: 22,
          slot_expiration: 839322900,
          auth_accounts: [],
        },
      ]);
      // The transaction lists USD first; the state row is in canonical order all the same.
      expect(result.states[0]).toMatchObject({
        base_currency: 'USD',
        base_issuer: BITSTAMP_USD.issuer,
        counter_currency: 'XRP',
      });
      expect(lpTokenBalanceChange(t, XRP_USD_BITSTAMP).negated().toString()).toBe('294.354152174');
    });

    it('a bid keeps the auth accounts of the new slot, in order', async () => {
      const slotAccounts = ['rNy92d5CrBQ1eC5HUokq1LDfcuLPvTfh4X', 'rJrFQCQKgUJwG6bnDLyX33ea4DwWcjk6P3'];
      const t = variant(await recorded('bid'), (_tx, meta) => {
        body(meta, 2).FinalFields.AuctionSlot.AuthAccounts = slotAccounts.map((Account) => ({
          AuthAccount: { Account },
        }));
      });
      expect(parser.parse(t, XRPL).governance[0].auth_accounts).toEqual(slotAccounts);
    });
  });

  describe('state rows', () => {
    it('swap_payment_xrp_iou: the reserves after the swap; the AMM fields are absent, as no AMM node is there', async () => {
      expect(parser.parse(await recorded('swap_payment_xrp_iou'), XRPL).states).toStrictEqual([
        {
          amm_account: XRP_RLUSD,
          base_currency: RLUSD.currency,
          base_issuer: RLUSD.issuer,
          counter_currency: 'XRP',
          counter_issuer: '',
          reserve_base: '2447341.562339902',
          reserve_counter: '1823900.107357',
          deleted: false,
        },
      ]);
    });

    it('deposit_single_asset: a reserve whose node is absent is left out', async () => {
      const [state] = parser.parse(await recorded('deposit_single_asset'), XRPL).states;
      expect(state).not.toHaveProperty('reserve_base');
      expect(state).toMatchObject({
        reserve_counter: '1846230.856091',
        lp_supply: '1791163807.530941',
        trading_fee: 205,
      });
    });

    describe("amounts in rippled's mantissa and exponent form are normalised like every other amount", () => {
      it("an LPTokenBalance of '9993228242855706e-4' is stored as '999322824285.5706'", async () => {
        const t = variant(await recorded('vote'), (_tx, meta) => {
          ammBody(meta).FinalFields.LPTokenBalance.value = '9993228242855706e-4';
        });
        const [state] = parser.parse(t, XRPL).states;
        expect(state.lp_supply).toBe('999322824285.5706');
        expect(ammOracle(t.tx as Json, t.meta as Json, 'XRP').states[0].lp_supply).toBe('999322824285.5706');
      });

      it('bid: lp_supply, auction_price, bid_min, bid_max and price_paid are the plain bid, to the digit', async () => {
        const t = await caseTx('bid_exponent_form');
        // the input really is in exponent form
        expect(t.tx.BidMin.value).toBe('294354152174e-9');
        expect(ammBody(t.meta).FinalFields.LPTokenBalance.value).toBe('3340651434735374e-9');
        const result = parser.parse(t, XRPL);
        expect(result).toStrictEqual(parser.parse(await recorded('bid'), XRPL));
        expect(result.states[0]).toMatchObject({ lp_supply: '3340651.434735374', auction_price: '294.354152174' });
        expect(result.governance[0]).toMatchObject({
          bid_min: '294.354152174',
          bid_max: '294.354152174',
          price_paid: '294.354152174',
        });
      });

      it('create: lp_supply and a zero auction price in exponent form are the plain create', async () => {
        const t = await caseTx('create_exponent_form');
        expect(ammBody(t.meta).NewFields.LPTokenBalance.value).toBe('2236067977499789e-8');
        expect(ammBody(t.meta).NewFields.AuctionSlot.Price.value).toBe('0e0');
        const result = parser.parse(t, XRPL);
        expect(result).toStrictEqual(parser.parse(await recorded('create'), XRPL));
        expect(result.states[0]).toMatchObject({ lp_supply: '22360679.77499789', auction_price: '0' });
      });
    });

    it('pins the key order of every row kind', async () => {
      const swap = parser.parse(await recorded('offercreate_autobridged_pool_leg'), XRPL).swaps[0];
      expect(Object.keys(swap)).toEqual([
        'amm_account',
        'node_index',
        'base_currency',
        'base_issuer',
        'counter_currency',
        'counter_issuer',
        'base_amount',
        'counter_amount',
        'rate',
        'buyer',
        'seller',
        'taker',
        'autobridged_currency',
        'autobridged_issuer',
      ]);
      const created = parser.parse(await recorded('create'), XRPL);
      expect(Object.keys(created.states[0])).toEqual([
        'amm_account',
        'base_currency',
        'base_issuer',
        'counter_currency',
        'counter_issuer',
        'reserve_base',
        'reserve_counter',
        'lp_supply',
        'lp_currency',
        'trading_fee',
        'auction_holder',
        'auction_price',
        'auction_discounted_fee',
        'auction_expiration',
        'deleted',
      ]);
      const deposit = parser.parse(await recorded('deposit_two_asset'), XRPL).liquidity[0];
      expect(Object.keys(deposit)).toEqual([
        'amm_account',
        'account',
        'initiator',
        'event',
        'mode',
        'base_amount',
        'counter_amount',
        'lp_tokens',
      ]);
      const vote = parser.parse(await recorded('vote'), XRPL).governance[0];
      expect(Object.keys(vote)).toEqual(['amm_account', 'kind', 'account', 'fee_voted', 'trading_fee_after']);
      const bid = parser.parse(await recorded('bid'), XRPL).governance[0];
      expect(Object.keys(bid)).toEqual([
        'amm_account',
        'kind',
        'account',
        'bid_min',
        'bid_max',
        'price_paid',
        'slot_holder',
        'slot_discounted_fee',
        'slot_expiration',
        'auth_accounts',
      ]);
    });
  });

  describe.each(ALL)('invariants: %s', (name) => {
    let t: ParserTx;
    let result: ParsedAmm;
    beforeAll(async () => {
      t = await caseTx(name);
      result = parser.parse(t, XRPL);
    });

    it('the input is deep-frozen and left as it was', () => {
      expect(Object.isFrozen(t.meta.AffectedNodes)).toBe(true);
      const before = JSON.stringify(t);
      parser.parse(t, XRPL);
      expect(JSON.stringify(t)).toBe(before);
    });

    it('matches the oracle written from the spec', () => {
      expect(result).toStrictEqual(ammOracle(t.tx as Json, t.meta as Json, 'XRP'));
    });

    it('row keys are unique, and swap nodes never collide with order-book exchange nodes', () => {
      const unique = (keys: string[]) => expect(new Set(keys).size).toBe(keys.length);
      const bookNodes = exchangeParser.parse(t, XRPL).map((e) => e.node_index);
      unique([...result.swaps.map((s) => String(s.node_index)), ...bookNodes.map(String)]);
      unique(result.states.map((s) => s.amm_account));
      unique(result.liquidity.map((l) => l.amm_account));
      unique(result.liquidity.map((l) => `${l.account} ${l.amm_account}`));
      unique(result.governance.map((g) => g.amm_account));
    });

    it('every amount is a finite BigNumber', () => {
      const amounts = [
        ...result.swaps.flatMap((s) => [s.base_amount, s.counter_amount, s.rate]),
        ...result.states.flatMap((s) => [s.reserve_base, s.reserve_counter, s.lp_supply, s.auction_price]),
        ...result.liquidity.flatMap((l) => [l.base_amount, l.counter_amount, l.lp_tokens]),
        ...result.governance.flatMap((g) => [g.bid_min, g.bid_max, g.price_paid]),
      ].filter((a) => a !== undefined);
      for (const a of amounts) {
        expect(typeof a).toBe('string');
        expect(new BigNumber(a as string).isFinite()).toBe(true);
      }
    });

    it('each swap: the pool took one side in and gave the other out, by the amounts of the row', () => {
      for (const s of result.swaps) {
        const base = poolBalanceChange(t, s.amm_account, s.base_currency, s.base_issuer);
        const counter = poolBalanceChange(t, s.amm_account, s.counter_currency, s.counter_issuer);
        const baseOut = s.buyer === s.taker;
        expect(baseOut ? base.isNegative() && counter.isPositive() : base.isPositive() && counter.isNegative()).toBe(
          true,
        );
        expect(base.abs().toString()).toBe(new BigNumber(s.base_amount).toString());
        expect(counter.abs().toString()).toBe(new BigNumber(s.counter_amount).toString());
        expect(s.base_amount).not.toMatch(/^-/);
        expect(s.counter_amount).not.toMatch(/^-/);
      }
    });

    it('each swap: rate, sides and amounts are what ExchangeParser makes of an offer by the pool with those amounts', () => {
      for (const s of result.swaps) {
        expect(asBookExchange(t, s)).toMatchObject({
          base_currency: s.base_currency,
          base_issuer: s.base_issuer,
          counter_currency: s.counter_currency,
          counter_issuer: s.counter_issuer,
          base_amount: s.base_amount,
          counter_amount: s.counter_amount,
          rate: s.rate,
          buyer: s.buyer,
          seller: s.seller,
          taker: s.taker,
        });
      }
    });

    it('each liquidity event: the amounts are the pool deltas and lp_tokens what the LP holders gained', () => {
      for (const l of result.liquidity) {
        const state = result.states.find((s) => s.amm_account === l.amm_account)!;
        expect(poolBalanceChange(t, l.amm_account, state.base_currency, state.base_issuer).toString()).toBe(
          new BigNumber(l.base_amount).toString(),
        );
        expect(poolBalanceChange(t, l.amm_account, state.counter_currency, state.counter_issuer).toString()).toBe(
          new BigNumber(l.counter_amount).toString(),
        );
        expect(l.lp_tokens).toBe(lpTokenBalanceChange(t, l.amm_account).toString());
        expect(holderLpChange(t, l.amm_account, state.lp_currency!).toString()).toBe(l.lp_tokens);
      }
      for (const g of result.governance.filter((row) => row.kind === 'bid')) {
        const state = result.states.find((s) => s.amm_account === g.amm_account)!;
        expect(holderLpChange(t, g.amm_account, state.lp_currency!).negated().toString()).toBe(g.price_paid);
      }
    });

    it('every pool with a row has a state row, unless no row could be made for it', () => {
      const pools = new Set(result.states.map((s) => s.amm_account));
      for (const row of [...result.swaps, ...result.liquidity, ...result.governance]) {
        expect(pools.has(row.amm_account)).toBe(true);
      }
    });
  });
});
