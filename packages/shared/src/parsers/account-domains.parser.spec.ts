import { deepFreeze } from '../test-utils/deep-freeze';
import { AccountDomainsParser, accountDomainVersion, ParsedAccountDomain } from './account-domains.parser';
import { changedAccountRoots } from './account-states.parser';
import { ParseContext, ParserTx } from './parser.interface';

type Json = Record<string, any>;

const CTX: ParseContext = { nativeCurrency: 'XRP', networkId: 0, partialPaymentFixLedger: 0 };

const ACCOUNT = 'rNorthpeakNorthpeakNorthpeakxxx';
const OTHER = 'rOtherOtherOtherOtherOtherOtherxxx';
/** `northpeak.example` and `harbor.example` as the ledger holds a Domain: upper-case hex. */
const NORTHPEAK = '6E6F7274687065616B2E6578616D706C65';
const HARBOR = '686172626F722E6578616D706C65';

const parser = new AccountDomainsParser();

function parserTx(tx: Json, nodes: Json[], result = 'tesSUCCESS', txIndex = 3): ParserTx {
  return deepFreeze({
    hash: 'HASH',
    ledger_index: 107_671_593,
    close_time: 1_700_000_000,
    tx_index: txIndex,
    client: null,
    tx: { TransactionType: 'AccountSet', Account: ACCOUNT, Fee: '12', Sequence: 5, ...tx },
    meta: { TransactionResult: result, TransactionIndex: txIndex, AffectedNodes: nodes },
  });
}

const modified = (finalFields: Json, previousFields?: Json, entry = 'AccountRoot'): Json => ({
  ModifiedNode: {
    LedgerEntryType: entry,
    FinalFields: finalFields,
    ...(previousFields === undefined ? {} : { PreviousFields: previousFields }),
  },
});
const created = (newFields: Json, entry = 'AccountRoot'): Json => ({
  CreatedNode: { LedgerEntryType: entry, NewFields: newFields },
});
const deleted = (finalFields: Json, previousFields?: Json, entry = 'AccountRoot'): Json => ({
  DeletedNode: {
    LedgerEntryType: entry,
    FinalFields: finalFields,
    ...(previousFields === undefined ? {} : { PreviousFields: previousFields }),
  },
});

const row = (over: Partial<ParsedAccountDomain>): ParsedAccountDomain => ({
  account: ACCOUNT,
  node_index: 0,
  domain_hex: '',
  deleted: false,
  invalid: false,
  ...over,
});

describe('AccountDomainsParser', () => {
  describe('AccountSet', () => {
    it('setting a Domain: the Domain is in FinalFields alone', () => {
      const t = parserTx({}, [modified({ Account: ACCOUNT, Domain: NORTHPEAK, Sequence: 6 }, { Sequence: 5 })]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: NORTHPEAK })]);
    });

    it('changing a Domain: the final one, with the old one in PreviousFields', () => {
      const t = parserTx({}, [
        modified({ Account: ACCOUNT, Domain: HARBOR, Sequence: 6 }, { Domain: NORTHPEAK, Sequence: 5 }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: HARBOR })]);
    });

    it('clearing a Domain: the old one is in PreviousFields alone, and the row is empty but not deleted', () => {
      const t = parserTx({ Domain: '' }, [
        modified({ Account: ACCOUNT, Sequence: 6 }, { Domain: NORTHPEAK, Sequence: 5 }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: '', deleted: false })]);
    });

    it('setting the same Domain again: FinalFields keeps it, PreviousFields has the other fields', () => {
      const t = parserTx({}, [
        modified(
          { Account: ACCOUNT, Domain: NORTHPEAK, Sequence: 6, Balance: '99999988' },
          { Sequence: 5, Balance: '100000000' },
        ),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: NORTHPEAK })]);
    });

    it('an AccountSet that sets other fields of an account without a Domain gives no row', () => {
      const t = parserTx({}, [modified({ Account: ACCOUNT, Flags: 1048576, Sequence: 6 }, { Flags: 0, Sequence: 5 })]);

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });
  });

  describe('created, modified and deleted account roots', () => {
    it('a Payment that creates an account without a Domain gives no row', () => {
      const t = parserTx({ TransactionType: 'Payment', Destination: OTHER, Amount: '20000000' }, [
        modified({ Account: ACCOUNT, Balance: '1' }, { Balance: '2' }),
        created({ Account: OTHER, Balance: '20000000', Sequence: 1 }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });

    it('a CreatedNode with NewFields.Domain gives a row with it', () => {
      const t = parserTx({ TransactionType: 'Payment' }, [
        modified({ Account: ACCOUNT, Balance: '1' }, { Balance: '2' }),
        created({ Account: OTHER, Balance: '20000000', Sequence: 1, Domain: HARBOR }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ account: OTHER, node_index: 1, domain_hex: HARBOR })]);
    });

    it('an AccountDelete of an account with a Domain: an empty Domain and deleted', () => {
      const t = parserTx({ TransactionType: 'AccountDelete', Destination: OTHER }, [
        deleted({ Account: ACCOUNT, Balance: '0', Domain: NORTHPEAK, Sequence: 5 }),
        modified({ Account: OTHER, Balance: '30' }, { Balance: '10' }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: '', deleted: true })]);
    });

    it('a DeletedNode that had a Domain in PreviousFields alone is deleted too', () => {
      const t = parserTx({ TransactionType: 'AccountDelete' }, [deleted({ Account: ACCOUNT }, { Domain: NORTHPEAK })]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: '', deleted: true })]);
    });

    it('an AccountDelete of an account without a Domain gives no row', () => {
      const t = parserTx({ TransactionType: 'AccountDelete' }, [deleted({ Account: ACCOUNT, Balance: '0' })]);

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });

    it('a Payment received by a dormant account with a Domain gives the row that teaches the Domain', () => {
      const t = parserTx({ TransactionType: 'Payment', Destination: OTHER, Amount: '10' }, [
        modified({ Account: ACCOUNT, Balance: '1' }, { Balance: '12' }),
        modified({ Account: OTHER, Balance: '30', Domain: HARBOR }, { Balance: '20' }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ account: OTHER, node_index: 1, domain_hex: HARBOR })]);
    });

    it('a failed transaction of a sender with a Domain still gives its row: the fee moved', () => {
      const t = parserTx(
        { TransactionType: 'Payment', Destination: OTHER, Amount: '10' },
        [modified({ Account: ACCOUNT, Balance: '1', Domain: NORTHPEAK, Sequence: 6 }, { Balance: '13', Sequence: 5 })],
        'tecPATH_DRY',
      );

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: NORTHPEAK })]);
    });

    it('a threaded ModifiedNode (no PreviousFields) gives no row', () => {
      const t = parserTx({ TransactionType: 'Payment' }, [modified({ Account: ACCOUNT, Domain: NORTHPEAK })]);

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });

    it('ignores the nodes that are not account roots', () => {
      const t = parserTx({ TransactionType: 'OfferCreate' }, [
        modified({ Account: ACCOUNT, Domain: NORTHPEAK }, { Sequence: 1 }, 'Offer'),
        created({ Account: ACCOUNT, Domain: NORTHPEAK }, 'DirectoryNode'),
        { SomethingElse: {} },
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });

    it('a transaction without AffectedNodes gives no row', () => {
      const t = deepFreeze<ParserTx>({ ...parserTx({}, []), meta: { TransactionResult: 'tesSUCCESS' } });

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });

    it('lists a row for every account root of a transaction, in the order of AffectedNodes, with that index', () => {
      const t = parserTx({ TransactionType: 'Payment' }, [
        { ModifiedNode: { LedgerEntryType: 'Offer', FinalFields: {}, PreviousFields: {} } },
        modified({ Account: ACCOUNT, Domain: NORTHPEAK }, { Balance: '2' }),
        created({ Account: OTHER, Domain: HARBOR }),
        modified({ Account: 'rThird', Domain: HARBOR }, { Balance: '2' }),
      ]);

      expect(parser.parse(t, CTX).map((r) => [r.account, r.node_index])).toStrictEqual([
        [ACCOUNT, 1],
        [OTHER, 2],
        ['rThird', 3],
      ]);
    });

    it('skips a root without an Account', () => {
      const t = parserTx({}, [modified({ Domain: NORTHPEAK }, { Sequence: 1 }), created({ Domain: NORTHPEAK })]);

      expect(parser.parse(t, CTX)).toStrictEqual([]);
    });
  });

  describe('transaction types', () => {
    it.each(['Import', 'SetHook', 'GenesisMint'])('reads a %s like any transaction', (type) => {
      const t = parserTx({ TransactionType: type }, [
        modified({ Account: ACCOUNT, Domain: NORTHPEAK, Balance: '5' }, { Balance: '4' }),
      ]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: NORTHPEAK })]);
    });
  });

  describe('a Domain that is not hex', () => {
    it.each([
      ['a number', 42],
      ['text that is not hex', 'ZZ'],
      ['an odd number of digits', 'ABC'],
      ['null', null],
      ['an object', {}],
    ])('%s is written as an empty Domain and marked invalid', (_what, domain) => {
      const t = parserTx({}, [modified({ Account: ACCOUNT, Domain: domain }, { Sequence: 5 })]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: '', invalid: true })]);
    });

    it('a created node with such a Domain is written empty and marked invalid too', () => {
      const t = parserTx({}, [created({ Account: OTHER, Domain: 42 })]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ account: OTHER, domain_hex: '', invalid: true })]);
    });

    it('lower-case hex is valid and kept as the ledger holds it', () => {
      const t = parserTx({}, [modified({ Account: ACCOUNT, Domain: 'abcdef09' }, { Sequence: 5 })]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: 'abcdef09' })]);
    });

    it('an empty Domain that is present is a row, and not invalid', () => {
      const t = parserTx({}, [modified({ Account: ACCOUNT, Domain: '' }, { Sequence: 5 })]);

      expect(parser.parse(t, CTX)).toStrictEqual([row({ domain_hex: '' })]);
    });
  });

  it('never writes to the transaction (it is deep-frozen) and gives the same rows again', () => {
    const t = parserTx({}, [modified({ Account: ACCOUNT, Domain: NORTHPEAK }, { Sequence: 5 })]);
    const before = JSON.stringify(t);

    const first = parser.parse(t, CTX);
    expect(JSON.stringify(t)).toBe(before);
    expect(parser.parse(t, CTX)).toStrictEqual(first);
  });
});

describe('accountDomainVersion', () => {
  it('is ledger_index * 2^32 + tx_index * 2^16 + node_index, as text', () => {
    expect(accountDomainVersion(107671593, 3, 5)).toBe('462445970643419141');
    expect(accountDomainVersion(0, 0, 0)).toBe('0');
    expect(accountDomainVersion(1, 0, 0)).toBe('4294967296');
    expect(accountDomainVersion(0, 1, 0)).toBe('65536');
    expect(accountDomainVersion(0, 0, 1)).toBe('1');
  });

  it('keeps the largest possible version exact: it passes 2^53', () => {
    expect(accountDomainVersion(4294967295, 65535, 65535)).toBe('18446744073709551615');
  });

  it('orders by ledger, then transaction, then node', () => {
    const versions = [
      accountDomainVersion(10, 2, 9),
      accountDomainVersion(10, 3, 0),
      accountDomainVersion(11, 0, 0),
    ].map(BigInt);
    expect(versions).toStrictEqual([...versions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe('changedAccountRoots', () => {
  it('lists the account roots with their operation and AffectedNodes index, without a node that was only threaded', () => {
    const t = parserTx({}, [
      created({ Account: OTHER }, 'DirectoryNode'),
      modified({ Account: ACCOUNT }, { Balance: '2' }),
      modified({ Account: OTHER }),
      deleted({ Account: 'rGone' }),
      created({ Account: 'rNew' }),
    ]);

    expect(
      changedAccountRoots(t).map(({ op, node_index, node }) => [op, node_index, node.LedgerEntryType]),
    ).toStrictEqual([
      ['ModifiedNode', 1, 'AccountRoot'],
      ['DeletedNode', 3, 'AccountRoot'],
      ['CreatedNode', 4, 'AccountRoot'],
    ]);
  });
});
