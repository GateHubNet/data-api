import BigNumber from 'bignumber.js';
import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { RawLedger } from '../ingest/raw-ledger';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { parseQuality } from '../util/quality';
import { canonicalPairKey, ExchangeParser, ParsedExchange } from './exchanges.parser';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

const XRPL: ParseContext = parseContextFor(getNetworkProfile('xrpl'));
const XAHAU: ParseContext = parseContextFor(getNetworkProfile('xahau'));

const TAKER = 'rTaker11111111111111111111111111';
const PROVIDER = 'rProvider11111111111111111111111';
/** The Bitstamp USD issuer the Ripple API tests use. */
const BITSTAMP = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
/** The gateway of the Ripple API's `USD+rMwj…/xrp` pair. */
const PAIR_ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

type Json = Record<string, any>;

const iou = (currency: string, issuer: string, value: string): Json => ({ currency, issuer, value });
const usd = (value: string): Json => iou('USD', BITSTAMP, value);

/**
 * The 8 trailing bytes of a BookDirectory: `exponent + 100` then a 7 byte mantissa. The quality they encode is
 * `mantissa * 10^exponent` in units of (TakerPays / TakerGets), counting native amounts in drops.
 */
function bookDirectory(mantissa: string, exponent: number): string {
  const quality = (exponent + 100).toString(16).padStart(2, '0') + BigInt(mantissa).toString(16).padStart(14, '0');
  return `${'AB'.repeat(24)}${quality}`.toUpperCase();
}

/** Quality 1 (TakerPays == TakerGets) when neither side is native. */
const QUALITY_ONE = bookDirectory('1000000000000000', -15);

interface OfferSides {
  pays: unknown;
  gets: unknown;
}

/** An Offer node that was partly or fully consumed: `before` -> `after` amounts. */
function exercised(before: OfferSides, after: OfferSides, over: Json = {}): Json {
  const { kind = 'ModifiedNode', ...fields } = over;
  return {
    [kind]: {
      LedgerEntryType: 'Offer',
      FinalFields: {
        Account: PROVIDER,
        BookDirectory: QUALITY_ONE,
        Sequence: 77,
        TakerPays: after.pays,
        TakerGets: after.gets,
        ...fields,
      },
      PreviousFields: { TakerPays: before.pays, TakerGets: before.gets },
    },
  };
}

function parserTx(nodes: Json[], tx: Json = {}, meta: Json = {}): ParserTx {
  return {
    hash: 'HASH',
    ledger_index: 5_000_000,
    close_time: 1_700_000_000,
    tx_index: 3,
    client: null,
    tx: { TransactionType: 'OfferCreate', Account: TAKER, Fee: '12', ...tx },
    meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 3, AffectedNodes: nodes, ...meta },
  };
}

const parser = new ExchangeParser();

describe('canonicalPairKey', () => {
  it('lower-cases currency and issuer', () => {
    expect(canonicalPairKey('USD', BITSTAMP)).toBe(`usd${BITSTAMP.toLowerCase()}`);
  });

  it("uses the literal 'undefined' for a missing issuer, like the reference (which concatenated undefined)", () => {
    expect(canonicalPairKey('XRP')).toBe('xrpundefined');
    expect(canonicalPairKey('XAH', undefined)).toBe('xahundefined');
  });
});

describe('parseQuality', () => {
  it('decodes the mantissa and exponent of the trailing 8 bytes', () => {
    expect(parseQuality(QUALITY_ONE, false, false).toString()).toBe('1');
    expect(parseQuality(bookDirectory('1234567890123456', -15), false, false).toString()).toBe('1.234567890123456');
    expect(parseQuality(bookDirectory('1234567890123456', -17), false, false).toString()).toBe('0.01234567890123456');
  });

  it('turns drops into whole native units on the paying side', () => {
    // TakerPays is native: drops per token -> native units per token.
    expect(parseQuality(QUALITY_ONE, true, false).toString()).toBe('0.000001');
  });

  it('turns drops into whole native units on the getting side', () => {
    expect(parseQuality(QUALITY_ONE, false, true).toString()).toBe('1000000');
  });

  it('leaves native/native alone: the shifts cancel', () => {
    expect(parseQuality(QUALITY_ONE, true, true).toString()).toBe('1');
  });

  it('reads a real book directory (mainnet ledger 107670360, XAH IOU per XRP)', () => {
    const real = 'F52A3ABAFA4C5856E662441BD92DD9C45B045889AD2BA46D50232398E57BA00E';
    // 0x232398E57BA00E * 10^(0x50 - 100), and TakerGets is native.
    expect(parseQuality(real, false, true).toString()).toBe('98.90763776958478');
  });

  it('is NaN for a book directory that is not hex, and never throws', () => {
    expect(parseQuality('not a book directory!!', false, false).isNaN()).toBe(true);
  });
});

describe('ExchangeParser', () => {
  it('does not mutate frozen input', () => {
    const t = deepFreeze(
      parserTx(
        [
          exercised({ pays: '2000000', gets: usd('4') }, { pays: '1000000', gets: usd('2') }),
          exercised({ pays: usd('3'), gets: '3000000' }, { pays: usd('1'), gets: '1000000' }),
        ],
        { TakerPays: usd('1'), TakerGets: iou('EUR', PAIR_ISSUER, '1') },
      ),
    );
    const before = JSON.stringify(t);

    const result = parser.parse(t, XRPL);

    expect(result).toHaveLength(2);
    expect(JSON.stringify(t)).toBe(before);
  });

  it('returns fresh objects that share nothing with the input and are deterministic', () => {
    const t = deepFreeze(
      parserTx([exercised({ pays: usd('3'), gets: '3000000' }, { pays: usd('1'), gets: '1000000' })]),
    );
    const first = parser.parse(t, XRPL);
    const second = parser.parse(t, XRPL);

    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);
    expect(Object.isFrozen(first[0])).toBe(false);
    for (const value of Object.values(first[0])) expect(['string', 'number']).toContain(typeof value);
  });

  describe('amounts are exact strings', () => {
    it('keeps every digit of an issued amount: 0.000001234567890123', () => {
      const [ex] = parser.parse(
        parserTx([
          exercised(
            { pays: usd('0.000001234567890123'), gets: '123456789' },
            { pays: usd('0'), gets: '0' },
            { kind: 'DeletedNode' },
          ),
        ]),
        XRPL,
      );

      expect(ex.base_amount).toBe('0.000001234567890123');
      expect(ex.counter_amount).toBe('123.456789');
    });

    it('does not round through a double: 2^53 + 1 survives', () => {
      const [ex] = parser.parse(
        parserTx([exercised({ pays: usd('9007199254740993.5'), gets: '1' }, { pays: usd('0.5'), gets: '0' })]),
        XRPL,
      );

      expect(ex.base_amount).toBe('9007199254740993');
      expect(ex.counter_amount).toBe('0.000001');
    });

    it('converts drops to whole units without exponent notation', () => {
      const [ex] = parser.parse(
        parserTx([exercised({ pays: '10', gets: usd('5') }, { pays: '9', gets: usd('4.5') })]),
        XRPL,
      );

      // One drop on the native side; base/counter are swapped so USD is the base.
      expect(ex.counter_amount).toBe('0.000001');
      expect(ex.base_amount).toBe('0.5');
    });

    it('reports amounts and rate as strings, offer_sequence and node_index as numbers', () => {
      const [ex] = parser.parse(
        parserTx([exercised({ pays: usd('3'), gets: '3000000' }, { pays: usd('1'), gets: '1000000' })]),
        XRPL,
      );

      expect(typeof ex.base_amount).toBe('string');
      expect(typeof ex.counter_amount).toBe('string');
      expect(typeof ex.rate).toBe('string');
      expect(typeof ex.offer_sequence).toBe('number');
      expect(typeof ex.node_index).toBe('number');
    });
  });

  describe('canonical ordering', () => {
    // The consumed offer sells 2 USD for 1 XRP, so the market price is 0.5 XRP per USD, whichever way round it is
    // stored. In drops per USD the quality is 500000 = 5e15 * 10^-10.
    const XRP_FOR_USD = bookDirectory('5000000000000000', -10);
    // As USD per drop: 2 USD / 1000000 drops = 2e-6 = 2e15 * 10^-21.
    const USD_FOR_XRP = bookDirectory('2000000000000000', -21);

    it('canonical ordering puts USD.rvYAf… before XRP: offer that pays XRP and gets USD swaps the sides', () => {
      const [ex] = parser.parse(
        parserTx(
          [
            exercised(
              { pays: '2000000', gets: usd('4') },
              { pays: '1000000', gets: usd('2') },
              { BookDirectory: XRP_FOR_USD },
            ),
          ],
          { Account: TAKER },
        ),
        XRPL,
      );

      expect(ex).toMatchObject({
        base_currency: 'USD',
        base_issuer: BITSTAMP,
        counter_currency: 'XRP',
        counter_issuer: '',
        base_amount: '2',
        counter_amount: '1',
        rate: '0.5',
        // The offer's owner bought XRP, so after the swap it sold the USD base and the taker bought it.
        buyer: TAKER,
        seller: PROVIDER,
        taker: TAKER,
        provider: PROVIDER,
      });
    });

    it('canonical ordering puts USD.rvYAf… before XRP: offer that pays USD and gets XRP is inverted', () => {
      const [ex] = parser.parse(
        parserTx(
          [
            exercised(
              { pays: usd('4'), gets: '2000000' },
              { pays: usd('2'), gets: '1000000' },
              { BookDirectory: USD_FOR_XRP },
            ),
          ],
          { Account: TAKER },
        ),
        XRPL,
      );

      expect(ex).toMatchObject({
        base_currency: 'USD',
        base_issuer: BITSTAMP,
        counter_currency: 'XRP',
        counter_issuer: '',
        base_amount: '2',
        counter_amount: '1',
        rate: '0.5',
        buyer: PROVIDER,
        seller: TAKER,
      });
    });

    it('inverts with the default BigNumber precision, like the reference (1/3 stops at 20 places)', () => {
      const THREE = bookDirectory('3000000000000000', -15);
      const [ex] = parser.parse(
        parserTx([
          exercised(
            { pays: usd('3'), gets: iou('USD', PAIR_ISSUER, '1') },
            { pays: usd('0'), gets: iou('USD', PAIR_ISSUER, '0') },
            { BookDirectory: THREE },
          ),
        ]),
        XRPL,
      );

      // base = USD.rvYAf (pays), counter = USD.rMwj (gets): 'usdrmwj' < 'usdrvya' so the sides swap and q = 3 is kept.
      expect(ex.base_issuer).toBe(PAIR_ISSUER);
      expect(ex.rate).toBe('3');

      const [inverted] = parser.parse(
        parserTx([
          exercised(
            { pays: iou('USD', PAIR_ISSUER, '3'), gets: usd('1') },
            { pays: iou('USD', PAIR_ISSUER, '0'), gets: usd('0') },
            { BookDirectory: THREE },
          ),
        ]),
        XRPL,
      );
      expect(inverted.base_issuer).toBe(PAIR_ISSUER);
      expect(inverted.rate).toBe('0.33333333333333333333');
    });

    it('orders two issued currencies by currency code then issuer, case-insensitively', () => {
      const [ex] = parser.parse(
        parserTx([
          exercised(
            { pays: iou('USD', BITSTAMP, '1'), gets: iou('EUR', PAIR_ISSUER, '2') },
            { pays: iou('USD', BITSTAMP, '0'), gets: iou('EUR', PAIR_ISSUER, '0') },
          ),
        ]),
        XRPL,
      );

      expect([ex.base_currency, ex.counter_currency]).toEqual(['EUR', 'USD']);
    });

    it('decides the order of native against an issued currency with the native code of the network', () => {
      // 'XBT' sorts between 'XAH' and 'XRP': after the native asset on Xahau, before it on the XRP Ledger.
      const xbt = iou('XBT', BITSTAMP, '1');
      const nodes = [exercised({ pays: '1000000', gets: xbt }, { pays: '0', gets: iou('XBT', BITSTAMP, '0') })];

      const [onXrpl] = parser.parse(parserTx(nodes), XRPL);
      const [onXahau] = parser.parse(parserTx(nodes), XAHAU);

      expect(onXrpl.base_currency).toBe('XBT');
      expect(onXrpl.counter_currency).toBe('XRP');
      expect(onXahau.base_currency).toBe('XAH');
      expect(onXahau.counter_currency).toBe('XBT');
    });
  });

  describe('rate', () => {
    it('is counter per base: the market price of the swapped and the unswapped orientation agree', () => {
      const swapped = parser.parse(
        parserTx([
          exercised(
            { pays: '4000000', gets: usd('2') },
            { pays: '0', gets: usd('0') },
            { BookDirectory: bookDirectory('2000000000000000', -9) },
          ),
        ]),
        XRPL,
      )[0];
      const unswapped = parser.parse(
        parserTx([
          exercised(
            { pays: usd('2'), gets: '4000000' },
            { pays: usd('0'), gets: '0' },
            { BookDirectory: bookDirectory('5000000000000000', -22) },
          ),
        ]),
        XRPL,
      )[0];

      // 4 XRP for 2 USD: 2 XRP per USD both ways.
      expect(swapped.rate).toBe('2');
      expect(unswapped.rate).toBe('2');
    });

    it('is the full-precision BigNumber string, not rounded to 8 significant digits', () => {
      const [ex] = parser.parse(
        parserTx([
          exercised(
            { pays: iou('USD', BITSTAMP, '1'), gets: iou('USD', PAIR_ISSUER, '1') },
            { pays: iou('USD', BITSTAMP, '0'), gets: iou('USD', PAIR_ISSUER, '0') },
            { BookDirectory: bookDirectory('1234567890123456', -15) },
          ),
        ]),
        XRPL,
      );

      expect(ex.rate).toBe('1.234567890123456');
    });

    it('falls back to the amounts when the book directory cannot be decoded', () => {
      for (const directory of [undefined, 'zzzz', '']) {
        const [ex] = parser.parse(
          parserTx([
            exercised({ pays: usd('8'), gets: '4000000' }, { pays: usd('0'), gets: '0' }, { BookDirectory: directory }),
          ]),
          XRPL,
        );
        // 8 USD for 4 XRP, USD is the base: 0.5 XRP per USD.
        expect(ex.rate).toBe('0.5');
      }
    });

    it('leaves out an exchange whose rate cannot be known at all', () => {
      const nodes = [
        exercised({ pays: usd('8'), gets: '0' }, { pays: usd('0'), gets: '0' }, { BookDirectory: 'zzzz' }),
      ];

      expect(parser.parse(parserTx(nodes), XRPL)).toEqual([]);
    });
  });

  describe('which transactions and nodes count', () => {
    const consumed = () => exercised({ pays: usd('3'), gets: '3000000' }, { pays: usd('1'), gets: '1000000' });

    it('reads both ModifiedNode and DeletedNode offers', () => {
      const nodes = [
        consumed(),
        exercised({ pays: usd('3'), gets: '3000000' }, { pays: usd('0'), gets: '0' }, { kind: 'DeletedNode' }),
      ];

      expect(parser.parse(parserTx(nodes), XRPL).map((e) => e.node_index)).toEqual([0, 1]);
    });

    it('works for Payment as well as OfferCreate and says which in tx_type', () => {
      expect(parser.parse(parserTx([consumed()], { TransactionType: 'Payment' }), XRPL)[0].tx_type).toBe('Payment');
      expect(parser.parse(parserTx([consumed()], { TransactionType: 'OfferCreate' }), XRPL)[0].tx_type).toBe(
        'OfferCreate',
      );
    });

    it('ignores every other transaction type', () => {
      for (const type of ['OfferCancel', 'AMMDeposit', 'CheckCash', 'TrustSet', 'Remit']) {
        expect(parser.parse(parserTx([consumed()], { TransactionType: type }), XRPL)).toEqual([]);
      }
    });

    it('ignores a transaction that did not succeed, even when it claimed a fee', () => {
      for (const result of ['tecPATH_PARTIAL', 'tecUNFUNDED_OFFER', 'tefPAST_SEQ']) {
        expect(parser.parse(parserTx([consumed()], {}, { TransactionResult: result }), XRPL)).toEqual([]);
      }
    });

    it('ignores nodes that are not a consumed offer', () => {
      const created = {
        CreatedNode: {
          LedgerEntryType: 'Offer',
          NewFields: { Account: PROVIDER, TakerPays: usd('1'), TakerGets: '1000000', Sequence: 1 },
        },
      };
      const onlyPaysChanged = exercised({ pays: usd('3'), gets: '3000000' }, { pays: usd('1'), gets: '3000000' });
      delete onlyPaysChanged.ModifiedNode.PreviousFields.TakerGets;
      const unfundedRemoval = {
        DeletedNode: {
          LedgerEntryType: 'Offer',
          FinalFields: {
            Account: PROVIDER,
            BookDirectory: QUALITY_ONE,
            Sequence: 1,
            TakerPays: usd('1'),
            TakerGets: '1',
          },
        },
      };
      const rippleState = {
        ModifiedNode: {
          LedgerEntryType: 'RippleState',
          FinalFields: { Balance: usd('1') },
          PreviousFields: { TakerPays: usd('2'), TakerGets: '1' },
        },
      };
      const noFinalFields = {
        ModifiedNode: { LedgerEntryType: 'Offer', PreviousFields: { TakerPays: '1', TakerGets: '1' } },
      };

      expect(
        parser.parse(parserTx([created, onlyPaysChanged, unfundedRemoval, rippleState, noFinalFields, {}]), XRPL),
      ).toEqual([]);
    });

    it('ignores offers that involve an MPT amount: they have no currency or issuer to key on', () => {
      const mpt = { mpt_issuance_id: '0000000AABBCC', value: '5' };
      const nodes = [exercised({ pays: mpt, gets: '3000000' }, { pays: { ...mpt, value: '1' }, gets: '1000000' })];

      expect(parser.parse(parserTx(nodes), XRPL)).toEqual([]);
    });

    it('node_index is the index in AffectedNodes, not among the offers, and the meta is never written to', () => {
      const accountRoot = { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: {}, PreviousFields: {} } };
      const t = deepFreeze(parserTx([accountRoot, consumed(), accountRoot, consumed()]));

      const result = parser.parse(t, XRPL);

      expect(result.map((e) => e.node_index)).toEqual([1, 3]);
      expect(JSON.stringify(t.meta)).not.toContain('nodeIndex');
      expect(JSON.stringify(t.meta)).not.toContain('node_index');
    });

    it('takes offer_sequence and provider from the offer, taker from the transaction', () => {
      const [ex] = parser.parse(
        parserTx([
          exercised({ pays: usd('3'), gets: '3000000' }, { pays: usd('1'), gets: '1000000' }, { Sequence: 4242 }),
        ]),
        XRPL,
      );

      expect(ex.offer_sequence).toBe(4242);
      expect(ex.provider).toBe(PROVIDER);
      expect(ex.taker).toBe(TAKER);
    });
  });

  describe('autobridged OfferCreate sets autobridged_currency', () => {
    const EUR = iou('EUR', PAIR_ISSUER, '1');
    const GBP = iou('GBP', 'rGbpIssuer1111111111111111111111', '1');

    /**
     * An OfferCreate that pays EUR for GBP, bridged through XRP, crosses one EUR/XRP and one XRP/GBP offer. The
     * reference marks both exchanges with the currency on the far side of the bridge.
     */
    it('records the far currency of each leg, whichever way the exchange is stored', () => {
      const legs = parser.parse(
        parserTx(
          [
            // Offer: pays 2 EUR, gets 1 XRP.
            exercised(
              { pays: iou('EUR', PAIR_ISSUER, '2'), gets: '1000000' },
              { pays: iou('EUR', PAIR_ISSUER, '0'), gets: '0' },
            ),
            // Offer: pays 1 XRP, gets 3 GBP.
            exercised(
              { pays: '1000000', gets: iou('GBP', GBP.issuer, '3') },
              { pays: '0', gets: iou('GBP', GBP.issuer, '0') },
            ),
          ],
          { TransactionType: 'OfferCreate', TakerPays: EUR, TakerGets: GBP },
        ),
        XRPL,
      );

      // base EUR / counter XRP: base is the TakerPays currency, so the bridge ends in the TakerGets currency.
      expect(legs[0]).toMatchObject({
        base_currency: 'EUR',
        counter_currency: 'XRP',
        autobridged_currency: 'GBP',
        autobridged_issuer: GBP.issuer,
      });
      // base XRP / counter GBP: counter is the TakerGets currency, so the bridge started at the TakerPays currency.
      expect(legs[1]).toMatchObject({
        base_currency: 'GBP',
        counter_currency: 'XRP',
        autobridged_currency: 'EUR',
        autobridged_issuer: PAIR_ISSUER,
      });
    });

    it('covers the two remaining branches of the reference', () => {
      const tx = { TransactionType: 'OfferCreate', TakerPays: EUR, TakerGets: GBP };
      // counter is the XRP side, base is the TakerGets currency -> far side is TakerPays.
      const a = parser.parse(
        parserTx(
          [
            exercised(
              { pays: iou('GBP', GBP.issuer, '3'), gets: '1000000' },
              { pays: iou('GBP', GBP.issuer, '0'), gets: '0' },
            ),
          ],
          tx,
        ),
        XRPL,
      )[0];
      // base is the XRP side, counter is the TakerPays currency -> far side is TakerGets.
      const b = parser.parse(
        parserTx(
          [
            exercised(
              { pays: '1000000', gets: iou('EUR', PAIR_ISSUER, '2') },
              { pays: '0', gets: iou('EUR', PAIR_ISSUER, '0') },
            ),
          ],
          tx,
        ),
        XRPL,
      )[0];

      expect(a).toMatchObject({ autobridged_currency: 'EUR', autobridged_issuer: PAIR_ISSUER });
      expect(b).toMatchObject({ autobridged_currency: 'GBP', autobridged_issuer: GBP.issuer });
    });

    it('leaves the fields out when the transaction is not a bridge', () => {
      const offer = exercised(
        { pays: iou('EUR', PAIR_ISSUER, '2'), gets: '1000000' },
        { pays: iou('EUR', PAIR_ISSUER, '0'), gets: '0' },
      );
      const cases: Json[] = [
        // A Payment is never autobridged, whatever else it carries.
        { TransactionType: 'Payment', Amount: EUR, SendMax: GBP },
        { TransactionType: 'Payment', TakerPays: EUR, TakerGets: GBP },
        // One native leg: it is a plain EUR/XRP offer.
        { TransactionType: 'OfferCreate', TakerPays: EUR, TakerGets: '1000000' },
        // Neither of the transaction's currencies is on the crossed offer.
        { TransactionType: 'OfferCreate', TakerPays: iou('JPY', BITSTAMP, '1'), TakerGets: GBP },
      ];

      for (const tx of cases) {
        const [ex] = parser.parse(parserTx([offer], tx), XRPL);
        expect(ex).toBeDefined();
        expect(ex).not.toHaveProperty('autobridged_currency');
        expect(ex).not.toHaveProperty('autobridged_issuer');
      }
    });

    it('does not take an issued currency called like the native one for the native asset', () => {
      // An IOU named XAH on the XRP Ledger is not Xahau's native currency, nor is one named XRP on Xahau.
      const xahIou = iou('XAH', 'rswh1fvyLqHizBS2awu1vs6QcmwTBd9qiv', '5');
      const [ex] = parser.parse(
        parserTx([exercised({ pays: xahIou, gets: usd('5') }, { pays: { ...xahIou, value: '0' }, gets: usd('0') })]),
        XRPL,
      );

      expect(ex.base_issuer).not.toBe('');
      expect(ex.counter_issuer).not.toBe('');
    });
  });

  describe('native code follows ctx', () => {
    const node = exercised({ pays: '2000000', gets: usd('4') }, { pays: '1000000', gets: usd('2') });

    it('uses XRP on the XRP Ledger, with an empty issuer', () => {
      const [ex] = parser.parse(parserTx([node]), XRPL);

      expect(ex.counter_currency).toBe('XRP');
      expect(ex.counter_issuer).toBe('');
    });

    it('uses XAH on Xahau, with an empty issuer', () => {
      const [ex] = parser.parse(parserTx([node]), XAHAU);

      expect(ex.counter_currency).toBe('XAH');
      expect(ex.counter_issuer).toBe('');
      expect(ex.base_currency).toBe('USD');
      expect(JSON.stringify(ex)).not.toContain('XRP');
    });

    it('converts XAH drops like XRP drops (both have 6 decimals)', () => {
      const [ex] = parser.parse(parserTx([node]), XAHAU);

      expect(ex.counter_amount).toBe('1');
    });

    it('marks the autobridged currency of an XAH bridge with the XAH code', () => {
      const [ex] = parser.parse(
        parserTx(
          [
            exercised(
              { pays: iou('EUR', PAIR_ISSUER, '2'), gets: '1000000' },
              { pays: iou('EUR', PAIR_ISSUER, '0'), gets: '0' },
            ),
          ],
          { TakerPays: iou('EUR', PAIR_ISSUER, '2'), TakerGets: iou('GBP', BITSTAMP, '1') },
        ),
        XAHAU,
      );

      expect(ex.counter_currency).toBe('XAH');
      expect(ex.autobridged_currency).toBe('GBP');
    });
  });
});

describe('ExchangeParser golden', () => {
  function parseAll(
    ledgers: RawLedger[],
    ctx: ParseContext,
  ): { ledger: RawLedger; tx: ParserTx; exchange: ParsedExchange }[] {
    const out: { ledger: RawLedger; tx: ParserTx; exchange: ParsedExchange }[] = [];
    for (const ledger of ledgers) {
      for (const raw of ledger.transactions) {
        const tx = toParserTx(raw, ledger.header, null);
        for (const exchange of parser.parse(tx, ctx)) out.push({ ledger, tx, exchange });
      }
    }
    return out;
  }

  /** Offer nodes the reference counts: a successful Payment/OfferCreate that consumed (part of) an offer. */
  function independentCount(ledgers: RawLedger[]): number {
    let count = 0;
    for (const { transactions } of ledgers) {
      for (const { tx, meta } of transactions) {
        if (meta.TransactionResult !== 'tesSUCCESS') continue;
        if (tx.TransactionType !== 'Payment' && tx.TransactionType !== 'OfferCreate') continue;
        for (const affected of meta.AffectedNodes as Json[]) {
          const node = affected.ModifiedNode ?? affected.DeletedNode;
          if (node?.LedgerEntryType === 'Offer' && node.PreviousFields?.TakerPays && node.PreviousFields?.TakerGets)
            count++;
        }
      }
    }
    return count;
  }

  describe('ripple-mock', () => {
    const ledgers = FixtureLedgerSource.fromDir(join(FIXTURES, 'xrpl', 'ripple-mock')).list();
    const parsed = parseAll(ledgers, XRPL);
    const pair = parsed.filter(
      ({ exchange: e }) =>
        e.base_currency === 'USD' &&
        e.base_issuer === PAIR_ISSUER &&
        e.counter_currency === 'XRP' &&
        e.counter_issuer === '',
    );

    it('parses the 54 mock ledgers, which normalizeLedgerResponse hands out deep-frozen', () => {
      expect(ledgers).toHaveLength(54);
      expect(Object.isFrozen(ledgers[0].transactions[0].meta)).toBe(true);
    });

    // $REF/rhd-master/test/test.exchanges.js asserts per pair, not overall: GET
    // /v2/exchanges/USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q/xrp over these 54 ledgers returns exactly 5 exchanges.
    it('finds 5 USD+rMwj…/XRP exchanges, the count the Ripple API test asserts', () => {
      expect(pair).toHaveLength(5);
    });

    // The same test, "by date": start=2015-01-14T18:28:40 end=2015-01-14T18:51:40 returns 2 of them.
    it('finds 2 of them between 18:28:40 and 18:51:40, as the Ripple API test asserts', () => {
      const start = Date.UTC(2015, 0, 14, 18, 28, 40) / 1000;
      const end = Date.UTC(2015, 0, 14, 18, 51, 40) / 1000;

      expect(pair.filter(({ tx }) => tx.close_time >= start && tx.close_time <= end)).toHaveLength(2);
    });

    // The same test's Link header (limit=1) carries the marker of the second exchange, the start of page two:
    // USD|rMwj…|XRP||20150114182720|000011119603|00012|00004, so ledger 11119603, tx 12, node 4. The first one is
    // earlier in the same ledger.
    it('puts the first two of them in ledger 11119603: tx 1 node 1, then tx 12 node 4 (the Ripple marker)', () => {
      const [first, second] = pair;
      const closed = Date.UTC(2015, 0, 14, 18, 27, 20) / 1000;

      expect([first.tx.ledger_index, first.tx.tx_index, first.exchange.node_index]).toEqual([11119603, 1, 1]);
      expect([second.tx.ledger_index, second.tx.tx_index, second.exchange.node_index]).toEqual([11119603, 12, 4]);
      expect([first.tx.close_time, second.tx.close_time]).toEqual([closed, closed]);
    });

    it('yields them in ledger order, with the types the Ripple API test checks', () => {
      let last = 0;
      for (const { tx, exchange: ex } of pair) {
        expect(typeof ex.base_amount).toBe('string');
        expect(typeof ex.counter_amount).toBe('string');
        expect(typeof ex.rate).toBe('string');
        expect(typeof ex.offer_sequence).toBe('number');
        for (const field of ['buyer', 'seller', 'taker', 'provider', 'tx_type'] as const) {
          expect(typeof ex[field]).toBe('string');
        }
        expect(tx.ledger_index).toBeGreaterThanOrEqual(last);
        last = tx.ledger_index;
      }
    });

    // $REF/rhd-master/test/test.account.exchanges.js: rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg has at least 5 exchanges
    // and some in JPY, in BTC and in USD+rMwj…/XRP.
    it("finds the exchanges of the Ripple API test's account, in the currencies it filters on", () => {
      const account = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg';
      const mine = parsed.filter(({ exchange: e }) => e.buyer === account || e.seller === account);
      const trades = (currency: string) =>
        mine.filter(({ exchange: e }) => e.base_currency === currency || e.counter_currency === currency);

      expect(mine.length).toBeGreaterThanOrEqual(5);
      expect(trades('JPY').length).toBeGreaterThan(0);
      expect(trades('BTC').length).toBeGreaterThan(0);
      expect(pair.filter(({ exchange: e }) => e.buyer === account || e.seller === account).length).toBeGreaterThan(0);
    });

    it('agrees with an independent count of consumed offers (158 over the 54 ledgers)', () => {
      expect(independentCount(ledgers)).toBe(158);
      expect(parsed).toHaveLength(158);
    });

    it('has no autobridged exchange: the mock ledgers predate autobridging', () => {
      expect(parsed.filter(({ exchange: e }) => e.autobridged_currency !== undefined)).toEqual([]);
    });

    it('orders every pair canonically and states the rate as counter per base', () => {
      let checked = 0;
      for (const { exchange: e } of parsed) {
        const baseKey = canonicalPairKey(e.base_currency, e.base_issuer || undefined);
        const counterKey = canonicalPairKey(e.counter_currency, e.counter_issuer || undefined);
        expect(counterKey < baseKey).toBe(false);

        const rate = new BigNumber(e.rate);
        expect(rate.isFinite() && rate.gt(0)).toBe(true);

        // The rate is the offer's exact price, the amounts are what changed hands. They agree unless the amounts
        // are dust (a few drops, or 1e-8 of a token), where the ledger's rounding dominates.
        const [base, counter] = [new BigNumber(e.base_amount), new BigNumber(e.counter_amount)];
        if (base.gte('0.001') && counter.gte('0.001')) {
          expect(rate.minus(counter.dividedBy(base)).abs().dividedBy(rate).toNumber()).toBeLessThan(1e-3);
          checked++;
        }
      }
      expect(checked).toBe(144);
    });

    // BigNumber's default toString(), like the reference: exponent notation below 1e-6 (dust amounts such as 7.685e-8).
    it('uses plain or exponent-notation decimal strings and an empty issuer for XRP only', () => {
      const decimal = /^\d+(\.\d+)?(e[-+]\d+)?$/;
      for (const { exchange: e } of parsed) {
        expect(e.base_amount).toMatch(decimal);
        expect(e.counter_amount).toMatch(decimal);
        expect(e.base_issuer === '').toBe(e.base_currency === 'XRP');
        expect(e.counter_issuer === '').toBe(e.counter_currency === 'XRP');
      }
    });

    it('keeps an exponent-notation amount exact: 7.654812e-8 CNY for 0.0000015128088 JPY', () => {
      const dust = parsed.find(({ exchange: e }) => e.base_amount === '7.654812e-8');

      expect(dust?.exchange).toMatchObject({ counter_amount: '0.0000015128088', rate: '19.7628458498023715415' });
    });
  });

  describe('recorded xrpl ledgers', () => {
    const ledgers = FixtureLedgerSource.fromDir(join(FIXTURES, 'xrpl', 'recorded')).list();
    const parsed = parseAll(ledgers, XRPL);

    it('agrees with an independent count of consumed offers', () => {
      expect(parsed).toHaveLength(independentCount(ledgers));
      expect(parsed.length).toBeGreaterThan(0);
    });

    // The ripple-mock ledgers have no autobridged exchange, so the first one comes from the recorded mainnet ledgers:
    // OfferCreate 976219CD… in ledger 107670360 pays RLUSD for XAH (an issued currency named XAH) through XRP.
    it('autobridged OfferCreate sets autobridged_currency: 976219CD… in ledger 107670360', () => {
      const bridged = parsed.filter(({ exchange: e }) => e.autobridged_currency !== undefined);
      const hash = '976219CDD238AFEF0E463319C9534C9FE8DA29DB39C72BD75EC8963C9D22C405';
      const RLUSD = '524C555344000000000000000000000000000000';
      const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
      const XAH_ISSUER = 'rswh1fvyLqHizBS2awu1vs6QcmwTBd9qiv';

      expect(bridged.map(({ tx, exchange }) => [tx.hash, exchange.node_index])).toEqual([
        [hash, 5],
        [hash, 7],
      ]);
      expect(bridged[0].tx.ledger_index).toBe(107670360);
      expect(bridged[0].tx.tx.TransactionType).toBe('OfferCreate');

      // Node 5 crossed an XAH/XRP offer: the bridge ends in the TakerPays currency, RLUSD.
      expect(bridged[0].exchange).toMatchObject({
        base_currency: 'XAH',
        base_issuer: XAH_ISSUER,
        counter_currency: 'XRP',
        counter_issuer: '',
        base_amount: '75.129252573399',
        counter_amount: '0.75959',
        rate: '0.0101104426569118946',
        autobridged_currency: RLUSD,
        autobridged_issuer: RLUSD_ISSUER,
        tx_type: 'OfferCreate',
      });
      // Node 7 crossed an XRP/RLUSD offer: the bridge starts at the TakerGets currency, XAH. RLUSD sorts first.
      expect(bridged[1].exchange).toMatchObject({
        base_currency: RLUSD,
        base_issuer: RLUSD_ISSUER,
        counter_currency: 'XRP',
        counter_issuer: '',
        base_amount: '1',
        counter_amount: '0.75959',
        rate: '0.759589821496392',
        autobridged_currency: 'XAH',
        autobridged_issuer: XAH_ISSUER,
      });
    });

    it('never calls an issued currency native, whatever its code', () => {
      for (const { exchange: e } of parsed) {
        expect(e.base_issuer === '').toBe(e.base_currency === 'XRP');
        expect(e.counter_issuer === '').toBe(e.counter_currency === 'XRP');
      }
    });
  });

  describe('recorded xahau ledgers', () => {
    const ledgers = FixtureLedgerSource.fromDir(join(FIXTURES, 'xahau', 'recorded')).list();
    const parsed = parseAll(ledgers, XAHAU);

    it('agrees with an independent count of consumed offers and names the native leg XAH', () => {
      expect(parsed).toHaveLength(independentCount(ledgers));
      for (const { exchange: e } of parsed) {
        expect(e.base_currency).not.toBe('XRP');
        expect(e.counter_currency).not.toBe('XRP');
      }
    });
  });
});
