import { readFileSync } from 'fs';
import { join } from 'path';
import { delegatedFrom, SYNTHETIC_DELEGATE } from '../../test/synthetic-delegated';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { RawLedger } from '../ingest/raw-ledger';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { AccountStatesParser } from './account-states.parser';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';
import { ParsedStateTouch, StateTouchesParser } from './state-touches.parser';
import { changedTrustLines, TrustLineStatesParser } from './trust-line-states.parser';

type Json = Record<string, any>;

const CTX: ParseContext = { nativeCurrency: 'XRP', networkId: 0, partialPaymentFixLedger: 0 };
const XRPL = parseContextFor(getNetworkProfile('xrpl'));
const XAHAU = parseContextFor(getNetworkProfile('xahau'));
const XRPL_TESTNET = parseContextFor(getNetworkProfile('xrpl-testnet'));
const XAHAU_TESTNET = parseContextFor(getNetworkProfile('xahau-testnet'));

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

const ISSUER = 'rIssuerIssuerIssuerIssuerIssuerxx';
const HOLDER = 'rHolderHolderHolderHolderHolderxx';
const OTHER = 'rOtherOtherOtherOtherOtherOtherxx';
const DELEGATE = 'rDelegateDelegateDelegateDelegatexx';
const LP = '03D2DE40F9AC98BCBF944FEB5044DD88517CB050';

const parser = new StateTouchesParser();

function parserTx(tx: Json, nodes: Json[], result = 'tesSUCCESS', txIndex = 3): ParserTx {
  return deepFreeze({
    hash: 'HASH',
    ledger_index: 107_671_593,
    close_time: 1_700_000_000,
    tx_index: txIndex,
    client: null,
    tx: { TransactionType: 'Payment', Account: HOLDER, Fee: '12', Sequence: 5, ...tx },
    meta: { TransactionResult: result, TransactionIndex: txIndex, AffectedNodes: nodes },
  });
}

/** The fields of a RippleState: `low` is the node's low account, `high` its high one. */
const lineFields = (low: string, high: string, currency = 'USD', over: Json = {}): Json => ({
  Balance: { currency, issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-10' },
  LowLimit: { currency, issuer: low, value: '0' },
  HighLimit: { currency, issuer: high, value: '1000' },
  Flags: 0,
  ...over,
});

const modifiedLine = (final: Json, previous?: Json): Json => ({
  ModifiedNode: {
    LedgerEntryType: 'RippleState',
    FinalFields: final,
    ...(previous === undefined ? {} : { PreviousFields: previous }),
  },
});
const createdLine = (fields: Json): Json => ({ CreatedNode: { LedgerEntryType: 'RippleState', NewFields: fields } });
const deletedLine = (final: Json, previous?: Json): Json => ({
  DeletedNode: {
    LedgerEntryType: 'RippleState',
    FinalFields: final,
    ...(previous === undefined ? {} : { PreviousFields: previous }),
  },
});

const modifiedRoot = (final: Json, previous?: Json): Json => ({
  ModifiedNode: {
    LedgerEntryType: 'AccountRoot',
    FinalFields: final,
    ...(previous === undefined ? {} : { PreviousFields: previous }),
  },
});
const createdRoot = (fields: Json): Json => ({ CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: fields } });
const deletedRoot = (final: Json, previous?: Json): Json => ({
  DeletedNode: {
    LedgerEntryType: 'AccountRoot',
    FinalFields: final,
    ...(previous === undefined ? {} : { PreviousFields: previous }),
  },
});

const line = (account: string, counterparty: string, currency = 'USD'): ParsedStateTouch => ({
  kind: 'line',
  account,
  counterparty,
  currency,
});
const root = (account: string): ParsedStateTouch => ({ kind: 'account', account, counterparty: '', currency: '' });

describe('StateTouchesParser', () => {
  describe('lines', () => {
    it('writes a line touch for a created, a modified and a deleted RippleState, from the final fields', () => {
      const t = parserTx({ TransactionType: 'TrustSet' }, [
        // The line's identity (low account, high account, currency) is read from the final fields of the node: the NewFields of a
        // created node, the FinalFields of the others.
        createdLine(lineFields(ISSUER, HOLDER, 'USD')),
        modifiedLine(lineFields(ISSUER, OTHER, 'EUR', { Flags: 65536 }), { Flags: 0 }),
        // PreviousFields.Balance names another currency: the touch is the final one.
        deletedLine(lineFields(HOLDER, OTHER, 'GBP'), { Balance: { currency: 'XXX', issuer: 'r', value: '5' } }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([
        line(ISSUER, HOLDER, 'USD'),
        line(ISSUER, OTHER, 'EUR'),
        line(HOLDER, OTHER, 'GBP'),
      ]);
    });

    it('writes a deleted RippleState even when its node lists no PreviousFields', () => {
      const t = parserTx({ TransactionType: 'TrustSet' }, [deletedLine(lineFields(ISSUER, HOLDER))]);

      expect(parser.parse(t, CTX)).toStrictEqual([line(ISSUER, HOLDER)]);
    });

    it('writes nothing for a RippleState modified without PreviousFields', () => {
      // Threaded only: its PreviousTxnID moved and nothing of the line changed (the rule of trust_line_states).
      const t = parserTx({}, [modifiedLine(lineFields(ISSUER, HOLDER)), modifiedLine(lineFields(ISSUER, OTHER))]);

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });

    it('writes LP-currency lines too', () => {
      const t = parserTx({ TransactionType: 'AMMDeposit' }, [
        modifiedLine(lineFields(HOLDER, OTHER, LP), { Balance: { currency: LP, issuer: 'r', value: '-1' } }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([line(HOLDER, OTHER, LP)]);
    });

    it('takes the low account as `account` and the high one as `counterparty`, whichever way the transaction sent', () => {
      const t = parserTx({ Account: OTHER }, [modifiedLine(lineFields(ISSUER, OTHER), { Balance: {} })]);

      expect(parser.parse(t, CTX)).toStrictEqual([line(ISSUER, OTHER)]);
    });

    it('skips a RippleState without the fields it needs', () => {
      const good = lineFields(ISSUER, HOLDER);
      const withoutLow = { ...good, LowLimit: { currency: 'USD', value: '0' } };
      const withoutHigh = { ...good, HighLimit: undefined };
      const withoutCurrency = { ...good, Balance: { issuer: 'r', value: '0' } };
      const notText = { ...good, LowLimit: { currency: 'USD', issuer: 7, value: '0' } };
      const t = parserTx({}, [
        modifiedLine(withoutLow, { Flags: 0 }),
        modifiedLine(withoutHigh, { Flags: 0 }),
        modifiedLine(withoutCurrency, { Flags: 0 }),
        modifiedLine(notText, { Flags: 0 }),
        createdLine({ Flags: 0 }),
        // A node that has no FinalFields at all: it is only a thread.
        { ModifiedNode: { LedgerEntryType: 'RippleState', PreviousFields: { Flags: 0 } } },
        modifiedLine(good, { Flags: 0 }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([line(ISSUER, HOLDER)]);
    });
  });

  describe('accounts', () => {
    it('writes an account touch when Flags, TransferRate or Domain is among the PreviousFields', () => {
      for (const field of ['Flags', 'TransferRate', 'Domain']) {
        const t = parserTx({ TransactionType: 'Payment' }, [
          modifiedRoot({ Account: ISSUER, Balance: '1', Sequence: 9 }, { [field]: field === 'Domain' ? '' : 0 }),
        ]);

        expect([field, parser.parse(t, CTX)]).toStrictEqual([field, [root(ISSUER)]]);
      }
    });

    it('writes an account touch for a created and for a deleted AccountRoot, whatever changed', () => {
      const t = parserTx({ TransactionType: 'AccountDelete' }, [
        createdRoot({ Account: HOLDER, Balance: '20000000', Sequence: 1 }),
        // A deleted node needs no PreviousFields: the account is gone.
        deletedRoot({ Account: ISSUER, Balance: '0', Sequence: 7 }),
        deletedRoot({ Account: OTHER, Balance: '0' }, { Balance: '5' }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([root(HOLDER), root(ISSUER), root(OTHER)]);
    });

    it('writes an account touch for the sender of an AccountSet that sets Domain for the first time (only in FinalFields)', () => {
      // A field set for the first time is not in PreviousFields: the Domain is in FinalFields alone (D4 spec 3.1), and only
      // Balance and Sequence changed.
      const t = parserTx({ TransactionType: 'AccountSet', Account: ISSUER, Domain: '6C756D697472616465732E696F' }, [
        modifiedRoot(
          { Account: ISSUER, Balance: '1', Domain: '6C756D697472616465732E696F', Sequence: 6 },
          { Balance: '13', Sequence: 5 },
        ),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([root(ISSUER)]);
    });

    it('writes an account touch for the sender of an AccountSet that sets a TransferRate for the first time', () => {
      const t = parserTx({ TransactionType: 'AccountSet', Account: ISSUER, TransferRate: 1_002_000_000 }, [
        modifiedRoot(
          { Account: ISSUER, Balance: '1', TransferRate: 1_002_000_000, Sequence: 6 },
          { Balance: '13', Sequence: 5 },
        ),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([root(ISSUER)]);
    });

    it('writes no account touch for a Payment that changes only Balance and Sequence', () => {
      const t = parserTx({ TransactionType: 'Payment', Account: HOLDER }, [
        modifiedRoot({ Account: HOLDER, Balance: '1', Sequence: 6, Domain: '6162' }, { Balance: '13', Sequence: 5 }),
        // The destination's root: its Balance only. It has a Domain and a TransferRate, which this payment did not change.
        modifiedRoot({ Account: ISSUER, Balance: '99', TransferRate: 1_002_000_000, Domain: '6162' }, { Balance: '9' }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });

    it('writes no account touch for a root that was only threaded', () => {
      const t = parserTx({ TransactionType: 'AccountSet', Account: ISSUER }, [
        modifiedRoot({ Account: ISSUER, Balance: '1', Sequence: 6 }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });

    it('writes no account touch for an AccountRoot that is not the sender of the AccountSet, unless its own fields changed', () => {
      const t = parserTx({ TransactionType: 'AccountSet', Account: ISSUER }, [
        modifiedRoot({ Account: OTHER, Balance: '1' }, { Balance: '2' }),
        modifiedRoot({ Account: ISSUER, Balance: '1', Sequence: 6 }, { Balance: '13', Sequence: 5 }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([root(ISSUER)]);
    });

    it("an AccountSet signed by a Delegate touches the root of Account, not the Delegate's", () => {
      // The recorded AccountSet that sets a Domain for the first time (xrpl/account-domains), made a delegated one: its
      // sender's root keeps its Sequence change, the delegate's root loses the fee (Balance) and nothing else.
      const recorded = recordedRaw('xrpl/account-domains', SETS_DOMAIN_FIRST);
      const delegated = delegatedFrom(recorded.tx, 'synthetic-delegated-accountset');
      expect(delegated.tx.Delegate).toBe(SYNTHETIC_DELEGATE);
      const sender = delegated.tx.Account as string;

      const t = deepFreeze(toParserTx(delegated, recorded.ledger.header, null));
      const nodes: Json[] = t.meta.AffectedNodes;
      const delegateRoot = nodes
        .map((n) => Object.values(n)[0] as Json)
        .find((n) => n.FinalFields?.Account === SYNTHETIC_DELEGATE);
      // The synthetic delegate's node is a plain fee payment...
      expect(Object.keys(delegateRoot!.PreviousFields)).toEqual(['Balance']);
      // ...and the sender's root changed its Sequence alone.
      const senderRoot = nodes.map((n) => Object.values(n)[0] as Json).find((n) => n.FinalFields?.Account === sender);
      expect(Object.keys(senderRoot!.PreviousFields)).toEqual(['Sequence']);

      expect(parser.parse(t, XRPL)).toStrictEqual([root(sender)]);
    });

    it("an AccountSet signed by a Delegate that sets a flag touches the root of Account for the flag, not the Delegate's", () => {
      const t = parserTx({ TransactionType: 'AccountSet', Account: ISSUER, Delegate: DELEGATE, SetFlag: 8 }, [
        modifiedRoot({ Account: DELEGATE, Balance: '1' }, { Balance: '13' }),
        modifiedRoot({ Account: ISSUER, Balance: '1', Flags: 8_388_608, Sequence: 6 }, { Flags: 0, Sequence: 5 }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([root(ISSUER)]);
    });

    it('skips an AccountRoot without an Account', () => {
      const t = parserTx({ TransactionType: 'AccountSet', Account: ISSUER }, [
        modifiedRoot({ Balance: '1' }, { Flags: 0 }),
        createdRoot({ Balance: '1' }),
        modifiedRoot({ Account: 7 }, { Flags: 0 }),
        modifiedRoot({ Account: ISSUER }, { Flags: 0 }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([root(ISSUER)]);
    });
  });

  describe('a transaction', () => {
    it('writes the touches of a failed transaction as its metadata says', () => {
      // tecPATH_PARTIAL and tecUNFUNDED_OFFER take the fee and the sequence, and an AccountSet that fails still changes the
      // sender's root (a touch), while a failed Payment's metadata names no line.
      const failedSet = parserTx(
        { TransactionType: 'AccountSet', Account: ISSUER },
        [modifiedRoot({ Account: ISSUER, Balance: '1', Sequence: 6 }, { Balance: '13', Sequence: 5 })],
        'tecNO_PERMISSION',
      );
      const failedPayment = parserTx(
        { TransactionType: 'Payment', Account: HOLDER },
        [modifiedRoot({ Account: HOLDER, Balance: '1', Sequence: 6 }, { Balance: '13', Sequence: 5 })],
        'tecPATH_PARTIAL',
      );
      // A failed transaction whose metadata still names a line: a tecKILLED OfferCreate with a modified RippleState.
      const failedWithLine = parserTx(
        { TransactionType: 'OfferCreate', Account: HOLDER },
        [modifiedLine(lineFields(ISSUER, HOLDER), { Balance: {} })],
        'tecKILLED',
      );

      expect(parser.parse(failedSet, CTX)).toStrictEqual([root(ISSUER)]);
      expect(parser.parse(failedPayment, CTX)).toStrictEqual([]);
      expect(parser.parse(failedWithLine, CTX)).toStrictEqual([line(ISSUER, HOLDER)]);
    });

    it('writes the touches in the order of meta.AffectedNodes', () => {
      const t = parserTx({ TransactionType: 'AccountSet', Account: ISSUER }, [
        modifiedLine(lineFields(OTHER, HOLDER), { Balance: {} }),
        modifiedRoot({ Account: ISSUER, Balance: '1', Sequence: 6 }, { Balance: '13', Sequence: 5 }),
        createdLine(lineFields(ISSUER, HOLDER)),
        { ModifiedNode: { LedgerEntryType: 'Offer', FinalFields: {}, PreviousFields: { TakerGets: '1' } } },
        createdRoot({ Account: HOLDER, Balance: '1' }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([
        line(OTHER, HOLDER),
        root(ISSUER),
        line(ISSUER, HOLDER),
        root(HOLDER),
      ]);
    });

    it('gives each (kind, account, counterparty, currency) once per transaction', () => {
      const t = parserTx({ TransactionType: 'AccountSet', Account: ISSUER }, [
        modifiedLine(lineFields(ISSUER, HOLDER), { Balance: {} }),
        // The same line again (a ledger lists a node once, so this guards the key), and the same pair in another currency
        // and the same currency with another pair: those are different rows.
        modifiedLine(lineFields(ISSUER, HOLDER), { Flags: 0 }),
        modifiedLine(lineFields(ISSUER, HOLDER, 'EUR'), { Flags: 0 }),
        modifiedLine(lineFields(ISSUER, OTHER), { Flags: 0 }),
        modifiedRoot({ Account: ISSUER, Flags: 1 }, { Flags: 0 }),
        // The sender's root twice: by Flags and as the sender.
        modifiedRoot({ Account: ISSUER, Balance: '1' }, { Balance: '2' }),
        modifiedRoot({ Account: HOLDER, Flags: 1 }, { Flags: 0 }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([
        line(ISSUER, HOLDER),
        line(ISSUER, HOLDER, 'EUR'),
        line(ISSUER, OTHER),
        root(ISSUER),
        root(HOLDER),
      ]);
    });

    it('writes nothing for a transaction without AffectedNodes, or with nodes of other types', () => {
      expect(
        parser.parse(deepFreeze({ ...parserTx({}, []), meta: { TransactionResult: 'tesSUCCESS' } }), CTX),
      ).toStrictEqual([]);
      const t = parserTx({}, [
        { ModifiedNode: { LedgerEntryType: 'DirectoryNode', FinalFields: {}, PreviousFields: { Flags: 1 } } },
        { CreatedNode: { LedgerEntryType: 'Offer', NewFields: { Account: ISSUER } } },
        { UnknownNode: { LedgerEntryType: 'RippleState' } },
        null as unknown as Json,
      ]);
      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });

    it('does not modify a deep-frozen transaction, and the result shares nothing with it', () => {
      const t = parserTx({ TransactionType: 'AccountSet', Account: ISSUER, Domain: '6162' }, [
        createdLine(lineFields(ISSUER, HOLDER)),
        modifiedRoot({ Account: ISSUER, Domain: '6162' }, { Sequence: 5 }),
      ]);
      const before = JSON.stringify(t);

      const touches = parser.parse(t, CTX);

      expect(touches).toHaveLength(2);
      expect(JSON.stringify(t)).toBe(before);
      // The same input again gives the same touches, objects of their own.
      const again = parser.parse(t, CTX);
      expect(again).toStrictEqual(touches);
      expect(again[0]).not.toBe(touches[0]);
      // The key order of a row is the column order of the table after the position (kind, account, counterparty, currency).
      expect(Object.keys(touches[0])).toEqual(['kind', 'account', 'counterparty', 'currency']);
    });
  });
});

// -- the recorded cases -----------------------------------------------------------------------------------------------

interface Recorded {
  ledger: RawLedger;
  tx: RawLedger['transactions'][number];
}

const setCache = new Map<string, RawLedger[]>();

/** Every ledger of a fixture directory (`xrpl/account-state`...), loaded once. */
function ledgersOf(dir: string): RawLedger[] {
  if (!setCache.has(dir)) setCache.set(dir, FixtureLedgerSource.fromDir(join(FIXTURES, dir)).list());
  return setCache.get(dir)!;
}

/** A recorded transaction by its hash in a fixture directory. */
function recordedRaw(dir: string, hash: string): Recorded {
  for (const ledger of ledgersOf(dir)) {
    const tx = ledger.transactions.find((t) => t.hash === hash);
    if (tx) return { ledger, tx };
  }
  throw new Error(`${dir} has no transaction ${hash}`);
}

function recordedTx(dir: string, hash: string): ParserTx {
  const { ledger, tx } = recordedRaw(dir, hash);
  return deepFreeze(toParserTx(tx, ledger.header, null));
}

/** The case of `xrpl/state-touches` named in its `manifest.json`: the ledger and the transaction it names. */
function stateTouchesCase(name: string): { ledger: number; hash: string; type: string } {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'xrpl', 'state-touches', 'manifest.json'), 'utf8')) as {
    cases: Record<string, { ledger: number; hash: string; type: string }>;
  };
  const found = manifest.cases[name];
  if (!found) throw new Error(`xrpl/state-touches has no case named ${name}`);
  return found;
}

/**
 * Recorded transactions that other tasks recorded and this one reads in place (`test/fixtures/README.md`, "State
 * touches"): the directory, the transaction and what it is.
 */
const IN_PLACE = {
  /** `PreviousFields` Balance only: a payment through the issuer `rBitcoiNXev8VoVxV7pwoQx1sSfonVP9i3` and an UNITE hop. */
  payment_ripples_through_issuer: [
    'xrpl/account-state',
    '33B40BE22F00E669023312A6F7192EC20748CA5111DA180B81E5D6458DCDA06B',
  ],
  /** An OfferCreate that crosses two offers: four lines, over the XAH issuer and the RLUSD issuer. */
  offercreate_two_issued_lines: [
    'xrpl/account-state',
    'E75F47B22075C3554C321E125F127F71E2C440B03770A350886C943995690FA5',
  ],
  /** An AMMDeposit: the depositor's LP line (an LP currency) and nothing else. */
  ammdeposit_lp_line: ['xrpl/account-state', '45E37A13EEEA300014BEBBD81F915ECBE338481732B6E409579D7422B5BC684D'],
  /** The Domain of `rPo76…` changes: it is among the PreviousFields. */
  accountset_domain: ['xrpl/account-domains', '894FEA1CFABB94BF99E0B138516FA54BC46CFC3AA9B05C768656F1D1E180EA98'],
  trustset_preauthorizes: ['xrpl/account-state', '7CD6BB1BEAFB159C576910B8A442FCD86FA92B2E8454CF8BE6190299AC9609EA'],
  trustline_deleted: ['xrpl/account-state', '49F56DB0FC454C5AEF99E8C538188523F7B3BBF932DC95B2981DBF1C0ED054C5'],
  trustset_freeze: ['xrpl/account-state', '40574C8990CD1EAD6D9831D6A32CBE16E3412CE0BDE48F5B86750A8BD8156CAD'],
  xahau_trustset: ['xahau/objects', '2A1E6EADE207AB90023A2F050ED1766A7932C53776AF0A2287C90FF7B2A0F6FB'],
  xahau_payment_issued: ['xahau/objects', '1A8BE06C9600311F0A908AC263C4643BA4F90A904F01AE374B1F7F3018C28EBE'],
  remit_issued: ['xahau/recorded', '8C50C44787A12B785AA62377D0AFA6C4711E8E07EF68BA6E83DC286F7EE79AAF'],
} as const satisfies Record<string, readonly [string, string]>;

/** The recorded AccountSet that sets a Domain for the first time (xrpl/account-domains, ledger 107939675). */
const SETS_DOMAIN_FIRST = '7F95E7D0DC924ADFCCF31F13AF1C4720F31BFECABC6F6195876BE472BCA4A22F';

const inPlace = (name: keyof typeof IN_PLACE): ParserTx => {
  const [dir, hash] = IN_PLACE[name];
  return recordedTx(dir, hash);
};

describe('StateTouchesParser over the recorded cases', () => {
  describe('xrpl/state-touches', () => {
    const recorded = (name: string): ParserTx => recordedTx('xrpl/state-touches', stateTouchesCase(name).hash);

    it('names its cases in the manifest, each in a ledger of the directory', () => {
      for (const name of ['accountset_transfer_rate', 'accountset_allow_clawback', 'clawback']) {
        const c = stateTouchesCase(name);
        expect(ledgersOf('xrpl/state-touches').map((l) => l.header.ledger_index)).toContain(c.ledger);
        expect(recordedRaw('xrpl/state-touches', c.hash).ledger.header.ledger_index).toBe(c.ledger);
      }
    });

    it('accountset_transfer_rate: the sender of an AccountSet that sets a TransferRate for the first time (Balance and Sequence only)', () => {
      const t = recorded('accountset_transfer_rate');
      expect(t.tx).toMatchObject({ TransactionType: 'AccountSet', TransferRate: 1_002_000_000 });
      // Nothing but the fee and the sequence is in the PreviousFields: the sender rule is the only way to the touch.
      const node = (t.meta.AffectedNodes as Json[])[0].ModifiedNode;
      expect(Object.keys(node.PreviousFields).sort()).toEqual(['Balance', 'Sequence']);

      expect(parser.parse(t, XRPL)).toStrictEqual([root('rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq')]);
    });

    it('accountset_allow_clawback: one account touch for the sender, the Flags among the PreviousFields', () => {
      const t = recorded('accountset_allow_clawback');
      expect(t.tx).toMatchObject({ TransactionType: 'AccountSet', SetFlag: 16 });
      const node = (t.meta.AffectedNodes as Json[])[0].ModifiedNode;
      expect(Object.keys(node.PreviousFields)).toContain('Flags');

      expect(parser.parse(t, XRPL)).toStrictEqual([root('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De')]);
    });

    it("clawback: the clawed line, and no account touch where the roots' PreviousFields hold neither Flags, TransferRate nor Domain", () => {
      const t = recorded('clawback');
      expect(t.tx.TransactionType).toBe('Clawback');
      const roots = (t.meta.AffectedNodes as Json[])
        .map((n) => Object.values(n)[0] as Json)
        .filter((n) => n.LedgerEntryType === 'AccountRoot');
      // The issuer paid the fee: its root changed Balance and Sequence.
      expect(roots.map((n) => Object.keys(n.PreviousFields).sort())).toEqual([['Balance', 'Sequence']]);

      expect(parser.parse(t, XRPL)).toStrictEqual([
        line(
          'rYNKrtQaf3vUVWVK5sw9rJdPGDLbxZu89',
          'rYNK7JFGbJhkX8HhT4zw1LJ1Yiu3aa9Mp',
          '594F494E4B000000000000000000000000000000',
        ),
      ]);
    });
  });

  describe('xrpl, read in place', () => {
    it('accountset_domain: a changed Domain gives one account touch for the sender', () => {
      const t = inPlace('accountset_domain');
      const node = (t.meta.AffectedNodes as Json[])[0].ModifiedNode;
      expect(Object.keys(node.PreviousFields).sort()).toEqual(['Balance', 'Domain', 'Sequence']);

      expect(parser.parse(t, XRPL)).toStrictEqual([root('rPo76joT4HVuvyomAqnapVcX3tYvmAxhHT')]);
    });

    it('accountset_domain, set first (xrpl/account-domains 107939675): the Domain is only in FinalFields, and the sender is touched', () => {
      const t = recordedTx('xrpl/account-domains', SETS_DOMAIN_FIRST);
      const node = (t.meta.AffectedNodes as Json[])[0].ModifiedNode;
      expect(Object.keys(node.PreviousFields).sort()).toEqual(['Balance', 'Sequence']);
      expect(node.FinalFields.Domain).toBe('6C756D697472616465732E696F');

      expect(parser.parse(t, XRPL)).toStrictEqual([root('rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM')]);
    });

    it('payment_ripples_through_issuer: the four lines it moves and no account (their roots change Balance and Sequence only)', () => {
      expect(parser.parse(inPlace('payment_ripples_through_issuer'), XRPL)).toStrictEqual([
        line(
          'r3kMfcHp6T9qqcgxQq3QKwtXWfB5AvqJNW',
          'rQKSaCbjYGdYosuPSLLTjzHN19Gwtyx4U6',
          '554E495445000000000000000000000000000000',
        ),
        line(
          'rahy16q3BiPwKSyHVXSZb4rgiz5z7keS3f',
          'rBitcoiNXev8VoVxV7pwoQx1sSfonVP9i3',
          '4249547800000000000000000000000000000000',
        ),
        line(
          'rahy16q3BiPwKSyHVXSZb4rgiz5z7keS3f',
          'rQKSaCbjYGdYosuPSLLTjzHN19Gwtyx4U6',
          '554E495445000000000000000000000000000000',
        ),
        line(
          'rBitcoiNXev8VoVxV7pwoQx1sSfonVP9i3',
          'rLhDWnBFitrn8iW8e5m7bVKqFS5raK1NbP',
          '4249547800000000000000000000000000000000',
        ),
      ]);
    });

    it('offercreate_two_issued_lines: all four lines the offer crossed, in the order of the metadata', () => {
      expect(parser.parse(inPlace('offercreate_two_issued_lines'), XRPL)).toStrictEqual([
        line('rswh1fvyLqHizBS2awu1vs6QcmwTBd9qiv', 'rK33HzbC3VTiC7EuSXHwuiFHyhUrJK6m1r', 'XAH'),
        line('rswh1fvyLqHizBS2awu1vs6QcmwTBd9qiv', 'rUfp2CFb3nP1zEqTzXhCkMXrHVnf4ciuwe', 'XAH'),
        line(
          'rK33HzbC3VTiC7EuSXHwuiFHyhUrJK6m1r',
          'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
          '524C555344000000000000000000000000000000',
        ),
        line(
          'rm9oxnf2QRUckx5YDVYHMCN1stbu1ngjW',
          'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
          '524C555344000000000000000000000000000000',
        ),
      ]);
    });

    it("ammdeposit_lp_line: the depositor's LP line is written, and the pool account and the AMM node are not", () => {
      expect(parser.parse(inPlace('ammdeposit_lp_line'), XRPL)).toStrictEqual([
        line(
          'r33tgUCVDn8UauxP7PQNbuME6Bnbh1Fxxi',
          'rHzdYeU9fABeVg6WjmKBXwPCrdqWmGhHdx',
          '03D2DE40F9AC98BCBF944FEB5044DD88517CB050',
        ),
      ]);
    });

    it('trustset_preauthorizes (tfSetfAuth): the created line, and not the issuer root that paid the fee and a reserve', () => {
      expect(parser.parse(inPlace('trustset_preauthorizes'), XRPL)).toStrictEqual([
        line(
          'rfffsukWALJB1PXYk7H8xkR6UJUDT8nMJE',
          'rJdo3ig1gWqLQQrs6wjbEeLNf3aGsR8qfD',
          '5553445600000000000000000000000000000000',
        ),
      ]);
    });

    it('trustline_deleted: the DeletedNode is the touch', () => {
      expect(parser.parse(inPlace('trustline_deleted'), XRPL)).toStrictEqual([
        line(
          'rsMeJ5p6qzVARADTYhvZbHqwkfyN18U2XH',
          'rfffsukWALJB1PXYk7H8xkR6UJUDT8nMJE',
          '5553445600000000000000000000000000000000',
        ),
      ]);
    });

    it('trustset_freeze: the frozen line', () => {
      expect(parser.parse(inPlace('trustset_freeze'), XRPL)).toStrictEqual([
        line('rsbgrRPMTykHoStSYst8jbqkscAnHCPWY8', 'rKQxxMQxm6jHV82bq4BCwyfcxcGG9GPWiU', 'LBR'),
      ]);
    });
  });

  describe('xahau, read in place', () => {
    it('xahau_trustset: the line of a TrustSet', () => {
      expect(parser.parse(inPlace('xahau_trustset'), XAHAU)).toStrictEqual([
        line('rXUMMaPpZqPutoRszR29jtC8amWq3APkx', 'r9PfV3sQpKLWxccdg3HL2FXKxGW2orAcLE', 'USD'),
      ]);
    });

    it('xahau_payment_issued (EVR): the two lines of the payment', () => {
      expect(parser.parse(inPlace('xahau_payment_issued'), XAHAU)).toStrictEqual([
        line('rEvernodee8dJLaFsujS6q1EiXvZYmHXr8', 'rHktfGUbjqzU4GsYCMc1pDjdHXb5CJamto', 'EVR'),
        line('rfTLEjZfT7t7PmfUHUHwwXLqBWnVLsxyz1', 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8', 'EVR'),
      ]);
    });

    it('remit_issued: its six lines, and no account (the roots change Balance, TouchCount and the like)', () => {
      const t = inPlace('remit_issued');
      expect(t.tx.TransactionType).toBe('Remit');

      expect(parser.parse(t, XAHAU)).toStrictEqual([
        line('rodinGM9xiKq7rDDnLPyieREkqGJ6zKyb', 'rDripFkNyrKz7XUEWKCa18aTeGQ9mi7afj', 'RVN'),
        line('rxxxx9gmp1DSJ8bE4Gya48VtRdPPz7mHF', 'rE8CnkPE7KY3MFurBUSEZdm8aFrehqUsWy', 'XXX'),
        line('rodinGM9xiKq7rDDnLPyieREkqGJ6zKyb', 'rE8CnkPE7KY3MFurBUSEZdm8aFrehqUsWy', 'RVN'),
        line('rDripFkNyrKz7XUEWKCa18aTeGQ9mi7afj', 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8', 'EVR'),
        line('rE8CnkPE7KY3MFurBUSEZdm8aFrehqUsWy', 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8', 'EVR'),
        line('rxxxx9gmp1DSJ8bE4Gya48VtRdPPz7mHF', 'rDripFkNyrKz7XUEWKCa18aTeGQ9mi7afj', 'XXX'),
      ]);
    });
  });

  describe('agrees with the two state parsers it indexes', () => {
    const lines = new TrustLineStatesParser();
    const accounts = new AccountStatesParser();
    /** Every fixture directory that holds ledgers. */
    const SETS: Array<[string, ParseContext]> = [
      ['xrpl/ripple-mock', XRPL],
      ['xrpl/recorded', XRPL],
      ['xrpl/amm', XRPL],
      ['xrpl/account-state', XRPL],
      ['xrpl/account-domains', XRPL],
      ['xrpl/nft', XRPL],
      ['xrpl/objects', XRPL],
      ['xrpl/path-payments', XRPL],
      ['xrpl/state-touches', XRPL],
      ['xahau/recorded', XAHAU],
      ['xahau/flag', XAHAU],
      ['xahau/uritoken', XAHAU],
      ['xahau/objects', XAHAU],
      ['xahau/mint', XAHAU],
      ['xrpl-testnet/recorded', XRPL_TESTNET],
      ['xahau-testnet/recorded', XAHAU_TESTNET],
    ];

    /** The line touches of the directory, each compared with the low-side row of `trust_line_states` of its node. */
    function checkLines(dir: string, ctx: ParseContext): number {
      let checked = 0;
      for (const ledger of ledgersOf(dir)) {
        for (const raw of ledger.transactions) {
          const t = deepFreeze(toParserTx(raw, ledger.header, null));
          // Each node gives the low account's state first and the high account's second: the first one is the touch.
          const expected = lines
            .parse(t, ctx)
            .filter((_, i) => i % 2 === 0)
            .map((s) => line(s.account, s.counterparty, s.currency));
          const touched = parser.parse(t, ctx).filter((s) => s.kind === 'line');
          expect(touched).toStrictEqual(expected);
          checked += expected.length;
        }
      }
      return checked;
    }

    /** The account touches of the directory, each an account of `account_states` in the same transaction. */
    function checkAccounts(dir: string, ctx: ParseContext): number {
      let checked = 0;
      for (const ledger of ledgersOf(dir)) {
        for (const raw of ledger.transactions) {
          const t = deepFreeze(toParserTx(raw, ledger.header, null));
          const changed = new Set(accounts.parse(t, ctx).map((s) => s.account));
          for (const touch of parser.parse(t, ctx).filter((s) => s.kind === 'account')) {
            expect(changed.has(touch.account)).toBe(true);
            checked++;
          }
        }
      }
      return checked;
    }

    it.each(SETS)(
      '%s: a line touch for each trust line of trust_line_states (once, low account first), and no other',
      (dir, ctx) => {
        checkLines(dir, ctx);
      },
    );

    it.each(SETS)('%s: an account touch only for an account of account_states, in the same transaction', (dir, ctx) => {
      checkAccounts(dir, ctx);
    });

    it('is not vacuous: the fixture directories hold line touches and account touches', () => {
      // (A directory of pseudo-transactions, like xahau/flag, or one without a change of flags has none of one kind.)
      expect(SETS.reduce((sum, [dir, ctx]) => sum + checkLines(dir, ctx), 0)).toBeGreaterThan(3000);
      expect(SETS.reduce((sum, [dir, ctx]) => sum + checkAccounts(dir, ctx), 0)).toBeGreaterThan(200);
    });
  });

  describe('the walk it shares with trust_line_states (changedTrustLines)', () => {
    it('selects the created, the deleted and the modified-with-PreviousFields RippleState nodes, with their identity and final fields', () => {
      const final = lineFields(ISSUER, HOLDER, 'EUR');
      const t = parserTx({ TransactionType: 'TrustSet' }, [
        {
          ModifiedNode: {
            LedgerEntryType: 'AccountRoot',
            FinalFields: { Account: ISSUER },
            PreviousFields: { Flags: 0 },
          },
        },
        createdLine(lineFields(ISSUER, OTHER, 'USD')),
        modifiedLine(lineFields(ISSUER, OTHER, 'GBP')),
        modifiedLine(final, { Flags: 0 }),
        deletedLine(lineFields(HOLDER, OTHER, 'JPY')),
        modifiedLine({ LowLimit: { issuer: ISSUER } }, { Flags: 0 }),
      ]);

      expect(
        changedTrustLines(t).map(({ op, node_index, low, high, currency }) => ({
          op,
          node_index,
          low,
          high,
          currency,
        })),
      ).toStrictEqual([
        { op: 'CreatedNode', node_index: 1, low: ISSUER, high: OTHER, currency: 'USD' },
        { op: 'ModifiedNode', node_index: 3, low: ISSUER, high: HOLDER, currency: 'EUR' },
        { op: 'DeletedNode', node_index: 4, low: HOLDER, high: OTHER, currency: 'JPY' },
      ]);
      // The fields are the node's own, the final ones.
      expect(changedTrustLines(t)[1].fields).toBe((t.meta.AffectedNodes as Json[])[3].ModifiedNode.FinalFields);
      // And the state touches are those nodes' lines, with the root that changed its Flags, in the order of the nodes.
      expect(parser.parse(t, CTX)).toStrictEqual([
        root(ISSUER),
        line(ISSUER, OTHER, 'USD'),
        line(ISSUER, HOLDER, 'EUR'),
        line(HOLDER, OTHER, 'JPY'),
      ]);
    });
  });
});
