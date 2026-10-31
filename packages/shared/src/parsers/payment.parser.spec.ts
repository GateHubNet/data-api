import { join } from 'path';
import { delegatedFrom, SYNTHETIC_DELEGATE } from '../../test/synthetic-delegated';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { LedgerHeader, RawLedger, RawTransaction } from '../ingest/raw-ledger';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import {
  editedMptCase,
  everyMptTransaction,
  mptCase,
  mptCaseContext,
  mptContext,
  mptNode,
} from '../test-utils/mpt-cases';
import { dropsToNative } from '../util/amount';
import { mptIssuerOf } from '../util/mpt';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';
import { BalanceChangeAmount, deliveredAmount, ParsedPayment, PaymentParser } from './payment.parser';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

const XRPL: ParseContext = parseContextFor(getNetworkProfile('xrpl'));
const XAHAU: ParseContext = parseContextFor(getNetworkProfile('xahau'));

const SENDER = 'rSender1111111111111111111111111';
const DEST = 'rDest11111111111111111111111111';
const ISSUER = 'rIssuer111111111111111111111111';
const PARTIAL_PAYMENT = 0x00020000;

type Json = Record<string, any>;

/** A parser input with sensible defaults; `tx`/`meta` overrides are shallow-merged. */
function parserTx(tx: Json = {}, meta: Json = {}, over: Partial<ParserTx> = {}): ParserTx {
  return {
    hash: 'HASH',
    ledger_index: 5_000_000,
    close_time: 1_700_000_000,
    tx_index: 3,
    client: null,
    tx: {
      TransactionType: 'Payment',
      Account: SENDER,
      Destination: DEST,
      Amount: '100000000',
      Fee: '12',
      ...tx,
    },
    meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 3, AffectedNodes: [], ...meta },
    ...over,
  };
}

/** AccountRoot balance change for `account`, in drops. */
function accountRoot(account: string, previous: string, final: string): Json {
  return {
    ModifiedNode: {
      LedgerEntryType: 'AccountRoot',
      FinalFields: { Account: account, Balance: final },
      PreviousFields: { Balance: previous },
    },
  };
}

/** A RippleState between `low` and `high` whose balance (low's perspective) went from `previous` to `final`. */
function rippleState(low: string, high: string, currency: string, previous: string, final: string): Json {
  return {
    ModifiedNode: {
      LedgerEntryType: 'RippleState',
      FinalFields: {
        Balance: { currency, issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: final },
        HighLimit: { currency, issuer: high, value: '1000' },
        LowLimit: { currency, issuer: low, value: '0' },
      },
      PreviousFields: { Balance: { currency, issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: previous } },
    },
  };
}

/** A native payment of 100 whole units from SENDER to DEST with a 12 drop fee. */
function nativePayment(): ParserTx {
  return parserTx(
    {},
    {
      AffectedNodes: [
        accountRoot(SENDER, '1000000000', '899999988'), // -(100 + 0.000012)
        accountRoot(DEST, '0', '100000000'),
      ],
    },
  );
}

const parser = new PaymentParser();

describe('PaymentParser', () => {
  const mptPayment = (name: string): ParsedPayment | undefined => parser.parse(mptCase(name), mptCaseContext(name));

  it('fee is added back to the native source change', () => {
    // The source AccountRoot drops by amount + fee (100.000012). The reported source change is the amount alone.
    const payment = parser.parse(nativePayment(), XRPL)!;

    expect(payment).toBeDefined();
    expect(payment.source).toBe(SENDER);
    expect(payment.destination).toBe(DEST);
    expect(payment.currency).toBe('XRP');
    expect(payment.issuer).toBeUndefined();
    expect(payment.amount).toBe('100');
    expect(payment.delivered_amount).toBe('100');
    expect(payment.fee_drops).toBe('12');
    expect(payment.source_balance_changes).toEqual([{ counterparty: '', currency: 'XRP', value: '-100' }]);
    expect(payment.destination_balance_changes).toEqual([{ counterparty: '', currency: 'XRP', value: '100' }]);
    expect(payment.source_currency).toBe('XRP');
  });

  it('adds no fee back when the delegate paid it: the source of a delegated Payment moves by the amount alone', () => {
    // The source AccountRoot drops by the amount only (100); the 12 drops of fee left the delegate's.
    const payment = parser.parse(
      parserTx(
        { Delegate: SYNTHETIC_DELEGATE },
        {
          AffectedNodes: [
            accountRoot(SENDER, '1000000000', '900000000'),
            accountRoot(DEST, '0', '100000000'),
            accountRoot(SYNTHETIC_DELEGATE, '50000012', '50000000'),
          ],
        },
      ),
      XRPL,
    )!;

    expect(payment.source_balance_changes).toEqual([{ counterparty: '', currency: 'XRP', value: '-100' }]);
    expect(payment.destination_balance_changes).toEqual([{ counterparty: '', currency: 'XRP', value: '100' }]);
    expect(payment.fee_drops).toBe('12');
  });

  // Synthetic, built here: no Payment of a delegate was found on the network. The delegate sweeps the delegator's XRP to
  // itself, so it is the Destination and pays the 12 drop fee out of what arrives.
  it("a delegate that is the Payment's Destination keeps its whole amount as its destination change", () => {
    const payment = parser.parse(
      parserTx(
        { Delegate: DEST },
        {
          AffectedNodes: [
            accountRoot(SENDER, '1000000000', '900000000'), // -100: the amount alone
            accountRoot(DEST, '50000000', '149999988'), // +100 - 0.000012: the amount less the fee it paid
          ],
        },
      ),
      XRPL,
    )!;

    expect(payment.source_balance_changes).toEqual([{ counterparty: '', currency: 'XRP', value: '-100' }]);
    expect(payment.destination_balance_changes).toEqual([{ counterparty: '', currency: 'XRP', value: '100' }]);
  });

  // Synthetic, built here: the delegate is the Destination of a token Payment, so its only native change is the fee.
  it('a token payment to its delegate leaves no native destination change', () => {
    const payment = parser.parse(
      parserTx(
        { Delegate: DEST, Amount: { currency: 'USD', issuer: ISSUER, value: '5' } },
        {
          AffectedNodes: [
            rippleState(SENDER, ISSUER, 'USD', '10', '5'),
            rippleState(DEST, ISSUER, 'USD', '0', '5'),
            accountRoot(DEST, '50000000', '49999988'), // -0.000012: the fee
          ],
        },
      ),
      XRPL,
    )!;

    expect(payment.source_balance_changes).toEqual([{ counterparty: ISSUER, currency: 'USD', value: '-5' }]);
    expect(payment.destination_balance_changes).toEqual([{ counterparty: ISSUER, currency: 'USD', value: '5' }]);
  });

  // Synthetic, built here: the delegate sweeps exactly its fee to itself, so its balance does not move and the library
  // reports no native change for it at all; what it received is still the amount.
  it('a delegate that receives exactly its fee has the amount as its destination change', () => {
    const payment = parser.parse(
      parserTx({ Delegate: DEST, Amount: '12' }, { AffectedNodes: [accountRoot(SENDER, '1000000000', '999999988')] }),
      XRPL,
    )!;

    expect(payment.destination_balance_changes).toEqual([{ counterparty: '', currency: 'XRP', value: '0.000012' }]);
  });

  it('payment to self is ignored', () => {
    expect(parser.parse(parserTx({ Account: SENDER, Destination: SENDER }), XRPL)).toBeUndefined();
  });

  it('ignores failed and non-payment transactions', () => {
    expect(parser.parse(parserTx({}, { TransactionResult: 'tecPATH_PARTIAL' }), XRPL)).toBeUndefined();
    expect(parser.parse(parserTx({ TransactionType: 'OfferCreate' }), XRPL)).toBeUndefined();
  });

  describe('MPT payments', () => {
    const ID = '0000012FFD9EE5DA93AC614B4DB94D7E0FCE415CA51BED47';
    const ISSUANCE_ISSUER = mptIssuerOf(ID);
    const mpt = { mpt_issuance_id: ID, value: '10' };

    it('reads a bare MPT Amount, the issuer from the ID, in integer units', () => {
      expect(parser.parse(parserTx({ Amount: mpt }), XRPL)).toMatchObject({
        currency: ID,
        issuer: ISSUANCE_ISSUER,
        amount: '10',
        delivered_amount: '10',
        source_currency: ID,
      });
    });

    it('stays dropped when mixed with another asset, as only MPTokensV2 can make that', () => {
      const other = { mpt_issuance_id: '0000012BFD9EE5DA93AC614B4DB94D7E0FCE415CA51BED47', value: '10' };
      expect(parser.parse(parserTx({ Amount: '1000000', SendMax: mpt }), XRPL)).toBeUndefined();
      expect(parser.parse(parserTx({ Amount: '1000000' }, { DeliveredAmount: mpt }), XRPL)).toBeUndefined();
      expect(parser.parse(parserTx({ Amount: '1000000' }, { delivered_amount: mpt }), XRPL)).toBeUndefined();
      expect(parser.parse(parserTx({ Amount: mpt, SendMax: '1000000' }), XRPL)).toBeUndefined();
      expect(parser.parse(parserTx({ Amount: mpt, SendMax: other }), XRPL)).toBeUndefined();
      expect(parser.parse(parserTx({ Amount: mpt }, { DeliveredAmount: other }), XRPL)).toBeUndefined();
    });

    it('stays dropped for an ID that is not 48 hex digits, and never throws on one', () => {
      for (const id of ['00', 'G'.repeat(48), ID + '00', 5]) {
        expect(parser.parse(parserTx({ Amount: { mpt_issuance_id: id, value: '10' } }), XRPL)).toBeUndefined();
      }
    });

    it('stays dropped when it failed, and when it is to self', () => {
      expect(mptPayment('payment_failed')).toBeUndefined();
      expect(parser.parse(parserTx({ Amount: mpt, Destination: SENDER }), XRPL)).toBeUndefined();
    });

    it('payment_holder_to_holder: the ID and its issuer, with one MPT entry on each side', () => {
      const t = mptCase('payment_holder_to_holder');
      const id = t.tx.Amount.mpt_issuance_id as string;
      const issuer = mptIssuerOf(id);
      expect(mptPayment('payment_holder_to_holder')).toMatchObject({
        source: t.tx.Account,
        destination: t.tx.Destination,
        currency: id,
        issuer,
        amount: '100000',
        delivered_amount: '100000',
        source_currency: id,
        source_balance_changes: [{ counterparty: issuer, currency: id, value: '-100000' }],
        destination_balance_changes: [{ counterparty: issuer, currency: id, value: '100000' }],
      });
      expect(mptPayment('payment_holder_to_holder')?.max_amount).toBeUndefined();
    });

    it("payment_mint: the issuer's source entry is the outstanding rise negated, with the destination as counterparty", () => {
      const t = mptCase('payment_mint');
      const id = t.tx.Amount.mpt_issuance_id as string;
      expect(mptPayment('payment_mint')).toMatchObject({
        source: mptIssuerOf(id),
        source_balance_changes: [{ counterparty: t.tx.Destination, currency: id, value: '-1' }],
        destination_balance_changes: [{ counterparty: mptIssuerOf(id), currency: id, value: '1' }],
      });
    });

    it("payment_redeem: the issuer's destination entry is the outstanding fall, with the source as counterparty", () => {
      const t = mptCase('payment_redeem');
      const id = t.tx.Amount.mpt_issuance_id as string;
      expect(mptPayment('payment_redeem')).toMatchObject({
        destination: mptIssuerOf(id),
        source_balance_changes: [{ counterparty: mptIssuerOf(id), currency: id, value: '-1' }],
        destination_balance_changes: [{ counterparty: t.tx.Account, currency: id, value: '1' }],
      });
    });

    it("payment_transfer_fee: max_amount is SendMax, and the source's entry holds the fee", () => {
      const t = mptCase('payment_transfer_fee');
      const payment = mptPayment('payment_transfer_fee');
      expect(payment).toMatchObject({ amount: '1000000', delivered_amount: '1000000', max_amount: t.tx.SendMax.value });
      expect(payment?.source_balance_changes[0].value).toBe('-1005890');
      expect(payment?.destination_balance_changes[0].value).toBe('1000000');
    });

    it('payment_before_delivered_fix: delivered_amount is the amount', () => {
      const payment = mptPayment('payment_before_delivered_fix');
      expect(payment?.delivered_amount).toBe(payment?.amount);
      expect(payment?.delivered_amount).toBe('1');
    });

    // Synthetic, edited from payment_holder_to_holder (no partial MPT payment was read, FINDINGS): tfPartialPayment set, the nodes
    // moved by 40000, and DeliveredAmount and delivered_amount 40000.
    it('a partial payment delivers what the metadata stored', () => {
      const t = mptCase('payment_holder_to_holder');
      const partial = editedMptCase('payment_holder_to_holder', (tx, meta) => {
        tx.Flags = PARTIAL_PAYMENT;
        const delivered = { mpt_issuance_id: tx.Amount.mpt_issuance_id, value: '40000' };
        meta.DeliveredAmount = delivered;
        meta.delivered_amount = delivered;
        mptNode(meta, 'MPToken', (f) => f.Account === t.tx.Account).PreviousFields.MPTAmount = '40000';
        mptNode(meta, 'MPToken', (f) => f.Account === t.tx.Destination).FinalFields.MPTAmount = '56267452';
      });
      const payment = parser.parse(partial, XRPL);
      expect(payment).toMatchObject({ amount: '100000', delivered_amount: '40000' });
      expect(payment?.source_balance_changes[0].value).toBe('-40000');
      expect(payment?.destination_balance_changes[0].value).toBe('40000');
    });

    // Synthetic, edited from payment_mint: the amounts of the transaction are not digits.
    it('reads an amount that is not digits as 0, and never throws', () => {
      const bad = editedMptCase('payment_mint', (tx, meta) => {
        tx.Amount.value = 'x';
        meta.delivered_amount.value = 'x';
      });
      expect(parser.parse(bad, XRPL)).toMatchObject({ amount: '0', delivered_amount: '0' });
    });

    it('reads the fee as for any payment, and leaves no native entry of it', () => {
      const t = mptCase('payment_holder_to_holder');
      const payment = mptPayment('payment_holder_to_holder');
      expect(payment?.fee_drops).toBe(t.tx.Fee);
      for (const change of [...payment!.source_balance_changes, ...payment!.destination_balance_changes]) {
        expect(change.currency).toBe(t.tx.Amount.mpt_issuance_id);
      }
    });

    it('leaves out an entry of value 0: a payment whose nodes moved nothing', () => {
      const none = editedMptCase('payment_holder_to_holder', (_tx, meta) => {
        meta.AffectedNodes = [];
      });
      expect(parser.parse(none, XRPL)).toMatchObject({ source_balance_changes: [], destination_balance_changes: [] });
    });

    it('reads the same from every recorded MPT payment, on both networks, with the sum of the two sides matching the fee', () => {
      let read = 0;
      for (const { network, t } of everyMptTransaction()) {
        if (t.tx.TransactionType !== 'Payment' || t.meta.TransactionResult !== 'tesSUCCESS') continue;
        const payment = parser.parse(t, mptContext(network))!;
        read += 1;
        expect(payment.currency).toBe(t.tx.Amount.mpt_issuance_id);
        expect(payment.issuer).toBe(mptIssuerOf(payment.currency));
        expect(payment.delivered_amount).toMatch(/^\d+$/);
        const entryOf = (changes: BalanceChangeAmount[]) => changes.find((c) => c.currency === payment.currency);
        expect(BigInt(entryOf(payment.destination_balance_changes)!.value)).toBe(BigInt(payment.delivered_amount));
        expect(BigInt(entryOf(payment.source_balance_changes)!.value) <= -BigInt(payment.delivered_amount)).toBe(true);
      }
      expect(read).toBeGreaterThanOrEqual(6);
    });
  });

  describe('Xahau native currency is XAH', () => {
    it('remaps every native currency to ctx.nativeCurrency', () => {
      const payment = parser.parse(nativePayment(), XAHAU)!;

      expect(payment.currency).toBe('XAH');
      expect(payment.source_currency).toBe('XAH');
      expect(payment.source_balance_changes).toEqual([{ counterparty: '', currency: 'XAH', value: '-100' }]);
      expect(payment.destination_balance_changes).toEqual([{ counterparty: '', currency: 'XAH', value: '100' }]);
      for (const change of [...payment.source_balance_changes, ...payment.destination_balance_changes]) {
        expect(change.currency).toBe('XAH');
      }
    });

    it('remaps a native SendMax source currency', () => {
      const payment = parser.parse(
        parserTx(
          { Amount: { currency: 'USD', issuer: ISSUER, value: '5' }, SendMax: '7000000' },
          { AffectedNodes: [accountRoot(SENDER, '10000000', '2999988'), rippleState(DEST, ISSUER, 'USD', '0', '5')] },
        ),
        XAHAU,
      )!;

      expect(payment.source_currency).toBe('XAH');
      expect(payment.max_amount).toBe('7');
      expect(payment.source_balance_changes).toEqual([{ counterparty: '', currency: 'XAH', value: '-7' }]);
    });

    it('does not remap an issued currency that happens to be called XRP', () => {
      const payment = parser.parse(
        parserTx(
          { Amount: { currency: 'XRP', issuer: ISSUER, value: '5' } },
          { AffectedNodes: [rippleState(DEST, ISSUER, 'XRP', '0', '5')] },
        ),
        XAHAU,
      )!;

      expect(payment.currency).toBe('XRP');
      expect(payment.issuer).toBe(ISSUER);
      expect(payment.destination_balance_changes).toEqual([{ counterparty: ISSUER, currency: 'XRP', value: '5' }]);
    });
  });

  describe('delivered_amount', () => {
    const iou = (value: string) => ({ currency: 'USD', issuer: ISSUER, value });

    it('delivered_amount uses DeliveredAmount for partial payments', () => {
      const payment = parser.parse(
        parserTx({ Flags: PARTIAL_PAYMENT, Amount: '100000000' }, { DeliveredAmount: '40000000' }),
        XRPL,
      )!;

      expect(payment.amount).toBe('100');
      expect(payment.delivered_amount).toBe('40');
    });

    it('uses the value of an issued-currency DeliveredAmount', () => {
      const payment = parser.parse(
        parserTx({ Flags: PARTIAL_PAYMENT, Amount: iou('10') }, { DeliveredAmount: iou('2.5') }),
        XRPL,
      )!;

      expect(payment.amount).toBe('10');
      expect(payment.delivered_amount).toBe('2.5');
    });

    it('takes the delivered_amount that rippled adds to the metadata', () => {
      const payment = parser.parse(parserTx({ Flags: PARTIAL_PAYMENT }, { delivered_amount: '1500000' }), XRPL)!;

      expect(payment.delivered_amount).toBe('1.5');
    });

    it('defaults to Amount when the metadata does not say', () => {
      expect(parser.parse(parserTx({ Amount: '3000000' }), XRPL)!.delivered_amount).toBe('3');
      expect(parser.parse(parserTx({ Amount: iou('4.25') }), XRPL)!.delivered_amount).toBe('4.25');
    });

    it('falls back to Amount for an old partial payment whose delivered amount is unavailable (reference behavior)', () => {
      // payment.js ignores tfPartialPayment: `DeliveredAmount || Amount`. The row needs a number, not 'unavailable'.
      const old = parserTx({ Flags: PARTIAL_PAYMENT, Amount: '9000000' }, {}, { ledger_index: 100 });
      expect(parser.parse(old, XRPL)!.delivered_amount).toBe('9');

      const rippledSaysUnavailable = parserTx(
        { Flags: PARTIAL_PAYMENT, Amount: '9000000' },
        { delivered_amount: 'unavailable' },
      );
      expect(parser.parse(rippledSaysUnavailable, XRPL)!.delivered_amount).toBe('9');
    });

    describe('deliveredAmount()', () => {
      const FIX = XRPL.partialPaymentFixLedger;
      const partial = { Flags: PARTIAL_PAYMENT | 0x80000000, Amount: '100' };

      it('prefers DeliveredAmount, then delivered_amount, then Amount', () => {
        const tx = { Amount: '100' };
        expect(deliveredAmount(tx, { DeliveredAmount: '40', delivered_amount: '50' }, 10, XRPL)).toBe('40');
        expect(deliveredAmount(tx, { delivered_amount: '50' }, 10, XRPL)).toBe('50');
        expect(deliveredAmount(tx, {}, 10, XRPL)).toBe('100');
      });

      it('returns an issued-currency DeliveredAmount as is', () => {
        const amount = { currency: 'USD', issuer: ISSUER, value: '1' };
        expect(deliveredAmount({ Amount: '100' }, { DeliveredAmount: amount }, 10, XRPL)).toBe(amount);
      });

      it('passes rippled "unavailable" through', () => {
        expect(deliveredAmount(partial, { delivered_amount: 'unavailable' }, FIX + 1, XRPL)).toBe('unavailable');
      });

      it('is unavailable for a partial payment up to and including the fix ledger, Amount strictly after it', () => {
        expect(deliveredAmount(partial, {}, FIX - 1, XRPL)).toBe('unavailable');
        expect(deliveredAmount(partial, {}, FIX, XRPL)).toBe('unavailable');
        expect(deliveredAmount(partial, {}, FIX + 1, XRPL)).toBe('100');
      });

      it('is Amount for a non-partial payment in any ledger', () => {
        expect(deliveredAmount({ Flags: 0x80000000, Amount: '100' }, {}, 1, XRPL)).toBe('100');
        expect(deliveredAmount({ Amount: '100' }, {}, 1, XRPL)).toBe('100');
      });

      it('uses the network boundary: Xahau has no unavailable window', () => {
        expect(XAHAU.partialPaymentFixLedger).toBe(0);
        expect(deliveredAmount(partial, {}, 1, XAHAU)).toBe('100');
      });
    });
  });

  describe('optional fields', () => {
    it('sets tags and invoice id when present', () => {
      const payment = parser.parse(
        parserTx({ SourceTag: 11, DestinationTag: 22, InvoiceID: 'ABCD'.repeat(16) }),
        XRPL,
      )!;

      expect(payment.source_tag).toBe(11);
      expect(payment.destination_tag).toBe(22);
      expect(payment.invoice_id).toBe('ABCD'.repeat(16));
    });

    it('omits absent tags, invoice id, max_amount and issuer', () => {
      const payment = parser.parse(parserTx(), XRPL)!;

      expect(payment).not.toHaveProperty('source_tag');
      expect(payment).not.toHaveProperty('destination_tag');
      expect(payment).not.toHaveProperty('invoice_id');
      expect(payment).not.toHaveProperty('max_amount');
      expect(payment).not.toHaveProperty('issuer');
    });

    it('keeps a tag of 0 (ruling R10) but leaves out an empty invoice id', () => {
      const payment = parser.parse(parserTx({ SourceTag: 0, DestinationTag: 0, InvoiceID: '' }), XRPL)!;

      expect(payment.source_tag).toBe(0);
      expect(payment.destination_tag).toBe(0);
      expect(payment).toHaveProperty('source_tag', 0);
      expect(payment).toHaveProperty('destination_tag', 0);
      expect(payment).not.toHaveProperty('invoice_id');
    });

    it('treats a null tag as absent', () => {
      const payment = parser.parse(parserTx({ SourceTag: null, DestinationTag: null }), XRPL)!;

      expect(payment).not.toHaveProperty('source_tag');
      expect(payment).not.toHaveProperty('destination_tag');
    });

    it('records max_amount and source_currency from an issued-currency SendMax', () => {
      const payment = parser.parse(
        parserTx({ Amount: '1000000', SendMax: { currency: 'EUR', issuer: ISSUER, value: '2' } }),
        XRPL,
      )!;

      expect(payment.max_amount).toBe('2');
      expect(payment.source_currency).toBe('EUR');
    });

    it('records max_amount and source_currency from a native SendMax', () => {
      const payment = parser.parse(
        parserTx({ Amount: { currency: 'USD', issuer: ISSUER, value: '1' }, SendMax: '3500000' }),
        XRPL,
      )!;

      expect(payment.max_amount).toBe('3.5');
      expect(payment.source_currency).toBe('XRP');
    });

    it('takes source_currency from the first source balance change when there is no SendMax', () => {
      const payment = parser.parse(
        parserTx(
          { Amount: { currency: 'USD', issuer: ISSUER, value: '5' } },
          {
            AffectedNodes: [rippleState(SENDER, ISSUER, 'USD', '10', '5'), rippleState(DEST, ISSUER, 'USD', '0', '5')],
          },
        ),
        XRPL,
      )!;

      expect(payment.source_currency).toBe('USD');
    });

    it('falls back to the amount currency when the source has no balance change', () => {
      const payment = parser.parse(parserTx({ Amount: '1000000' }, { AffectedNodes: [] }), XRPL)!;

      expect(payment.source_balance_changes).toEqual([]);
      expect(payment.destination_balance_changes).toEqual([]);
      expect(payment.source_currency).toBe('XRP');
    });

    it('drops source changes that are zero once the fee is added back', () => {
      // A payment that moves nothing but the fee out of the source.
      const payment = parser.parse(
        parserTx({}, { AffectedNodes: [accountRoot(SENDER, '1000000000', '999999988')] }),
        XRPL,
      )!;

      expect(payment.source_balance_changes).toEqual([]);
    });
  });

  describe('issuer', () => {
    const usd = (issuer: string, value = '10') => ({ currency: 'USD', issuer, value });

    it('is the Amount issuer when neither party is the issuer', () => {
      const payment = parser.parse(parserTx({ Amount: usd(ISSUER) }), XRPL)!;

      expect(payment.currency).toBe('USD');
      expect(payment.issuer).toBe(ISSUER);
    });

    it('issuer resolved from created trustline when destination is issuer', () => {
      // Amount.issuer == destination means "any issuer the destination trusts"; the trustline that this payment
      // created identifies the real one. The reference only looked at FinalFields and so never found it.
      const created = {
        CreatedNode: {
          LedgerEntryType: 'RippleState',
          NewFields: {
            Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '10' },
            HighLimit: { currency: 'USD', issuer: ISSUER, value: '0' },
            LowLimit: { currency: 'USD', issuer: DEST, value: '100' },
          },
        },
      };
      const payment = parser.parse(parserTx({ Amount: usd(DEST) }, { AffectedNodes: [created] }), XRPL)!;

      // The low side holds +10, so the high side owes it: the high account is the issuer.
      expect(payment.issuer).toBe(ISSUER);
    });

    it('a created trustline with a negative balance makes the low account the issuer', () => {
      const created = {
        CreatedNode: {
          LedgerEntryType: 'RippleState',
          NewFields: {
            Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-10' },
            HighLimit: { currency: 'USD', issuer: DEST, value: '100' },
            LowLimit: { currency: 'USD', issuer: ISSUER, value: '0' },
          },
        },
      };
      const payment = parser.parse(parserTx({ Amount: usd(DEST) }, { AffectedNodes: [created] }), XRPL)!;

      expect(payment.issuer).toBe(ISSUER);
    });

    it('uses an existing trustline of the destination when the source is the issuer', () => {
      const payment = parser.parse(
        parserTx(
          { Account: ISSUER, Amount: usd(ISSUER) },
          { AffectedNodes: [rippleState(DEST, ISSUER, 'USD', '0', '10')] },
        ),
        XRPL,
      )!;

      // Balance (low = destination) is positive, so the high account (ISSUER) is the issuer.
      expect(payment.issuer).toBe(ISSUER);
    });

    it('treats a balance that was negative before the payment as the low account being the issuer', () => {
      const payment = parser.parse(
        parserTx({ Amount: usd(DEST) }, { AffectedNodes: [rippleState(ISSUER, DEST, 'USD', '-5', '0')] }),
        XRPL,
      )!;

      expect(payment.issuer).toBe(ISSUER);
    });

    it('skips trustlines of other currencies and ones that lack a Balance in PreviousFields', () => {
      const other = rippleState(DEST, ISSUER, 'EUR', '0', '10');
      const flagsOnly = rippleState(DEST, ISSUER, 'USD', '0', '10');
      delete flagsOnly.ModifiedNode.PreviousFields.Balance;
      const payment = parser.parse(parserTx({ Amount: usd(DEST) }, { AffectedNodes: [other, flagsOnly] }), XRPL)!;

      expect(payment.issuer).toBe(ISSUER);
    });

    it('is left unset when no trustline identifies it', () => {
      const payment = parser.parse(parserTx({ Amount: usd(DEST) }, { AffectedNodes: [] }), XRPL)!;

      expect(payment).not.toHaveProperty('issuer');
    });
  });

  describe('purity', () => {
    it('does not mutate frozen input', () => {
      const issued = parserTx(
        {
          Amount: { currency: 'USD', issuer: DEST, value: '10' },
          SendMax: '7000000',
          Flags: PARTIAL_PAYMENT,
          DestinationTag: 5,
        },
        {
          DeliveredAmount: { currency: 'USD', issuer: DEST, value: '4' },
          AffectedNodes: [
            accountRoot(SENDER, '10000000', '2999988'),
            rippleState(DEST, ISSUER, 'USD', '0', '4'),
            accountRoot(DEST, '0', '1'),
          ],
        },
      );

      for (const input of [nativePayment(), issued]) {
        const before = JSON.stringify(input);
        deepFreeze(input);
        expect(() => parser.parse(input, XRPL)).not.toThrow();
        expect(JSON.stringify(input)).toBe(before);
      }
    });

    it('returns fresh objects that do not alias the input', () => {
      const input = nativePayment();
      const first = parser.parse(input, XRPL)!;
      first.source_balance_changes[0].value = 'tampered';
      first.source_balance_changes.push({ counterparty: '', currency: 'XRP', value: '1' });

      expect(parser.parse(input, XRPL)!.source_balance_changes).toEqual([
        { counterparty: '', currency: 'XRP', value: '-100' },
      ]);
    });

    it('is deterministic', () => {
      const input = deepFreeze(nativePayment());
      expect(parser.parse(input, XRPL)).toEqual(parser.parse(input, XRPL));
    });
  });
});

describe('toParserTx / parseContextFor', () => {
  const header: LedgerHeader = {
    ledger_index: 123,
    ledger_hash: 'LH',
    parent_hash: 'PH',
    account_hash: 'AH',
    transaction_hash: 'TH',
    total_coins: '99999999999999999',
    close_time: 1_700_000_000,
    parent_close_time: 1_699_999_990,
    close_time_resolution: 10,
    close_flags: 0,
  };

  it('flattens a raw transaction and its ledger header', () => {
    const raw: RawTransaction = {
      hash: 'TXHASH',
      tx: { TransactionType: 'Payment', Account: SENDER },
      meta: { TransactionIndex: 7, TransactionResult: 'tesSUCCESS' },
    };

    const parsed = toParserTx(raw, header, 'xumm');

    expect(parsed).toEqual({
      hash: 'TXHASH',
      ledger_index: 123,
      close_time: 1_700_000_000,
      tx_index: 7,
      tx: raw.tx,
      meta: raw.meta,
      client: 'xumm',
    });
    expect(toParserTx(raw, header, null).client).toBeNull();
  });

  it('derives the context from the network profile', () => {
    expect(parseContextFor(getNetworkProfile('xrpl'))).toEqual({
      nativeCurrency: 'XRP',
      networkId: 0,
      partialPaymentFixLedger: 4594094,
    });
    expect(parseContextFor(getNetworkProfile('xahau'))).toEqual({
      nativeCurrency: 'XAH',
      networkId: 21337,
      partialPaymentFixLedger: 0,
    });
  });
});

describe('PaymentParser golden', () => {
  function parseAll(ledgers: RawLedger[], ctx: ParseContext): { raw: RawTransaction; payment: ParsedPayment }[] {
    const out: { raw: RawTransaction; payment: ParsedPayment }[] = [];
    for (const ledger of ledgers) {
      for (const raw of ledger.transactions) {
        const payment = parser.parse(toParserTx(raw, ledger.header, null), ctx);
        if (payment) out.push({ raw, payment });
      }
    }
    return out;
  }

  /** Payments of the native currency with no SendMax: nothing but the fee and the amount leaves the source. */
  const directNative = (parsed: { raw: RawTransaction }[]) =>
    parsed.filter(({ raw }) => typeof raw.tx.Amount === 'string' && raw.tx.SendMax === undefined);

  describe('ripple-mock', () => {
    const ledgers = FixtureLedgerSource.fromDir(join(FIXTURES, 'xrpl', 'ripple-mock')).list();
    const parsed = parseAll(ledgers, XRPL);

    it('parses the 54 mock ledgers, which normalizeLedgerResponse hands out deep-frozen', () => {
      expect(ledgers).toHaveLength(54);
      expect(Object.isFrozen(ledgers[0].transactions[0].tx)).toBe(true);
      expect(Object.isFrozen(ledgers[0].transactions[0].meta)).toBe(true);
    });

    // $REF/rhd-master/test/test.payments.js: GET /v2/payments over the same 54 mock ledgers returns 182.
    it('finds 182 payments, the count the Ripple API test asserts', () => {
      expect(parsed).toHaveLength(182);
    });

    it('agrees with an independent count of successful Payments between different accounts', () => {
      const independent = ledgers
        .flatMap((ledger) => ledger.transactions)
        .filter(
          ({ tx, meta }) =>
            tx.TransactionType === 'Payment' &&
            meta.TransactionResult === 'tesSUCCESS' &&
            tx.Account !== tx.Destination,
        );
      expect(independent).toHaveLength(182);
    });

    it('yields complete rows: strings for amounts, an issuer for every issued currency', () => {
      for (const { payment } of parsed) {
        expect(payment.source).not.toBe(payment.destination);
        expect(payment.amount).toMatch(/^\d+(\.\d+)?$/);
        expect(payment.delivered_amount).toMatch(/^\d+(\.\d+)?$/);
        expect(payment.fee_drops).toMatch(/^\d+$/);
        expect(payment.source_currency).toBeTruthy();
        expect(payment.source_balance_changes.length).toBeGreaterThan(0);
        expect(payment.destination_balance_changes.length).toBeGreaterThan(0);
        if (payment.currency === 'XRP') expect(payment).not.toHaveProperty('issuer');
        else expect(payment.issuer).toMatch(/^r/);
        for (const change of [...payment.source_balance_changes, ...payment.destination_balance_changes]) {
          expect(change.counterparty === '').toBe(change.currency === 'XRP');
        }
      }
    });

    it('adds the fee back: a direct native payment moves exactly its amount out of the source', () => {
      const direct = directNative(parsed) as typeof parsed;
      expect(direct.length).toBe(99);
      for (const { payment } of direct) {
        expect(payment.source_balance_changes).toContainEqual({
          counterparty: '',
          currency: 'XRP',
          value: `-${payment.amount}`,
        });
      }
    });

    it('carries a tag of 0 through as 0', () => {
      const zeroTagged = parsed.filter(({ raw }) => raw.tx.SourceTag === 0 || raw.tx.DestinationTag === 0);

      expect(zeroTagged).toHaveLength(2);
      for (const { raw, payment } of zeroTagged) {
        if (raw.tx.SourceTag === 0) expect(payment.source_tag).toBe(0);
        if (raw.tx.DestinationTag === 0) expect(payment.destination_tag).toBe(0);
      }
    });

    it('keeps the delivered amount of the partial payments that report one', () => {
      expect(parsed.filter(({ payment }) => payment.delivered_amount !== payment.amount)).toHaveLength(3);
    });
  });

  // `synthetic-delegated-payment`, made from the recorded native Payment BAF0C2EC… (ledger 107670360, 15.151515 XRP, a 5000
  // drop fee) with a `Delegate` that paid the fee: hand-made, never recorded (none was found on the network). The payment it
  // makes is the original's: who paid the fee does not change what the source sent.
  it('gives a synthetic delegated Payment the row of the recorded Payment it is made from: the source sent the amount, not the amount less the fee', () => {
    const ledger = FixtureLedgerSource.fromDir(join(FIXTURES, 'xrpl', 'recorded'))
      .list()
      .find((l) => l.header.ledger_index === 107670360)!;
    const original = ledger.transactions.find(
      (t) => t.hash === 'BAF0C2EC22CFC229C9AABC02413EB6433A820F5689B69FD4AD83565A38EF77ED',
    )!;
    const delegated = delegatedFrom(original, 'synthetic-delegated-payment');

    const expected = parser.parse(toParserTx(original, ledger.header, null), XRPL)!;
    const payment = parser.parse(toParserTx(delegated, ledger.header, null), XRPL)!;

    expect(delegated.tx.Delegate).toBe(SYNTHETIC_DELEGATE);
    expect(expected.source_balance_changes).toEqual([{ counterparty: '', currency: 'XRP', value: '-15.151515' }]);
    expect(payment).toEqual(expected);
  });

  describe.each([
    ['xrpl', XRPL],
    ['xahau', XAHAU],
  ])('recorded %s ledgers', (network, ctx) => {
    const ledgers = FixtureLedgerSource.fromDir(join(FIXTURES, network, 'recorded')).list();
    const parsed = parseAll(ledgers, ctx);

    if (parsed.length === 0) {
      it.skip(`${network}: no parsable Payment in the recorded fixtures`, () => undefined);
      return;
    }

    it('uses the native currency of the network and nothing else for native amounts', () => {
      for (const { raw, payment } of parsed) {
        if (typeof raw.tx.Amount === 'string') expect(payment.currency).toBe(ctx.nativeCurrency);
        for (const change of [...payment.source_balance_changes, ...payment.destination_balance_changes]) {
          expect(change.counterparty === '').toBe(change.currency === ctx.nativeCurrency);
        }
      }
    });

    it('adds the fee back: a direct native payment moves exactly its amount out of the source', () => {
      const direct = directNative(parsed) as typeof parsed;
      expect(direct.length).toBeGreaterThan(0);
      for (const { payment } of direct) {
        expect(payment.source_currency).toBe(ctx.nativeCurrency);
        expect(payment.source_balance_changes).toContainEqual({
          counterparty: '',
          currency: ctx.nativeCurrency,
          value: `-${payment.amount}`,
        });
      }
    });

    it('delivers what the metadata says', () => {
      for (const { raw, payment } of parsed) {
        const delivered = (raw.meta.DeliveredAmount ?? raw.meta.delivered_amount ?? raw.tx.Amount) as
          | string
          | { value: string };
        expect(payment.delivered_amount).toBe(
          typeof delivered === 'string' ? dropsToNative(delivered) : delivered.value,
        );
      }
    });
  });
});
