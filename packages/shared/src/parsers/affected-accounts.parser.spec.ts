import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { deepFreeze } from '../test-utils/deep-freeze';
import { AffectedAccountsParser } from './affected-accounts.parser';
import { ParserTx, toParserTx } from './parser.interface';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

type Json = Record<string, any>;

const parser = new AffectedAccountsParser();

function parserTx(nodes: Json[], meta: Json = {}, tx: Json = {}): ParserTx {
  return deepFreeze({
    hash: 'HASH',
    ledger_index: 100,
    close_time: 1_700_000_000,
    tx_index: 0,
    client: null,
    tx: { TransactionType: 'Payment', Account: 'rSender', ...tx },
    meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: nodes, ...meta },
  });
}

const modified = (entry: string, fields: Json, previous: Json = {}): Json => ({
  ModifiedNode: { LedgerEntryType: entry, FinalFields: fields, PreviousFields: previous },
});

const txsOf = (...dir: string[]): ParserTx[] =>
  FixtureLedgerSource.fromDir(join(FIXTURES, ...dir))
    .list()
    .flatMap((ledger) => ledger.transactions.map((raw) => toParserTx(raw, ledger.header, null)));

describe('AffectedAccountsParser', () => {
  it('lists each account of the metadata once, in the order it first appears', () => {
    const t = parserTx([
      modified('AccountRoot', { Account: 'rSender', Balance: '1' }, { Balance: '2' }),
      modified('AccountRoot', { Account: 'rDest', Balance: '1' }, { Balance: '2' }),
      modified('DirectoryNode', { Owner: 'rSender', RootIndex: 'AB' }),
      modified('Escrow', { Account: 'rDest', Destination: 'rThird', Amount: '1' }),
    ]);

    expect(parser.parse(t)).toEqual(['rSender', 'rDest', 'rThird']);
  });

  it('finds the fields that name an account: Account, Owner, Destination, Issuer, Target', () => {
    const t = parserTx([
      modified('X', {
        Account: 'rAccount',
        Owner: 'rOwner',
        Destination: 'rDestination',
        Issuer: 'rIssuer',
        Target: 'rTarget',
      }),
    ]);

    expect(parser.parse(t)).toEqual(['rAccount', 'rOwner', 'rDestination', 'rIssuer', 'rTarget']);
  });

  it('finds the issuers of trustline limits and of offer amounts', () => {
    const t = parserTx([
      modified('RippleState', {
        Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '1' },
        HighLimit: { currency: 'USD', issuer: 'rHigh', value: '0' },
        LowLimit: { currency: 'USD', issuer: 'rLow', value: '0' },
      }),
      modified('Offer', {
        Account: 'rMaker',
        TakerGets: '5000000',
        TakerPays: { currency: 'EUR', issuer: 'rEurGate', value: '5' },
      }),
    ]);

    // The Balance issuer is the placeholder account ONE, which is not looked at.
    expect(parser.parse(t)).toEqual(['rHigh', 'rLow', 'rMaker', 'rEurGate']);
  });

  it('reads the new fields of a created node and the final fields of the others, never the previous ones', () => {
    const t = parserTx([
      { CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: { Account: 'rNew', Balance: '1' } } },
      {
        DeletedNode: {
          LedgerEntryType: 'Offer',
          FinalFields: { Account: 'rGone' },
          PreviousFields: { Owner: 'rNever' },
        },
      },
      modified('AccountRoot', { Account: 'rKept' }, { Account: 'rBefore' }),
    ]);

    expect(parser.parse(t)).toEqual(['rNew', 'rGone', 'rKept']);
  });

  it('keeps only addresses that start with r', () => {
    const t = parserTx([
      modified('X', { Account: 'rReal', Owner: '0000000000000000000000000000000000000000', Target: 'xNotAnAddress' }),
    ]);

    expect(parser.parse(t)).toEqual(['rReal']);
  });

  it.each(['tesSUCCESS', 'tecPATH_DRY', 'tecUNFUNDED_OFFER', 'tecNO_DST_INSUF_XRP', 'tefPAST_SEQ', 'terQUEUED'])(
    'lists the accounts of a %s transaction too',
    (result) => {
      const t = parserTx([modified('AccountRoot', { Account: 'rSender' }, { Balance: '2' })], {
        TransactionResult: result,
      });

      expect(parser.parse(t)).toEqual(['rSender']);
    },
  );

  it('returns nothing for metadata without nodes', () => {
    expect(parser.parse(parserTx([]))).toEqual([]);
    expect(parser.parse(parserTx(undefined as unknown as Json[]))).toEqual([]);
  });

  it('does not mutate frozen input', () => {
    const t = parserTx([
      modified('AccountRoot', { Account: 'rSender' }, { Balance: '2' }),
      modified('RippleState', { HighLimit: { issuer: 'rHigh' }, LowLimit: { issuer: 'rLow' } }),
    ]);
    const before = JSON.stringify(t);

    const first = parser.parse(t);
    expect(JSON.stringify(t)).toBe(before);
    expect(parser.parse(t)).toEqual(first);
  });

  describe.each([
    ['ripple-mock', ['xrpl', 'ripple-mock'], 933],
    ['recorded xrpl', ['xrpl', 'recorded'], 1306],
    ['recorded xahau', ['xahau', 'recorded'], 364],
  ])('%s ledgers', (_name, dir, count) => {
    const txs = txsOf(...dir);

    it('parses every transaction: unique r-addresses that always include the sender', () => {
      expect(txs).toHaveLength(count);

      for (const t of txs) {
        const accounts = parser.parse(t);
        expect(new Set(accounts).size).toBe(accounts.length);
        for (const account of accounts) expect(account[0]).toBe('r');
        // Paying the fee, or at least spending a sequence number, touches the sender.
        if (/^(tes|tec)/.test(t.meta.TransactionResult) && t.tx.Account !== 'rrrrrrrrrrrrrrrrrrrrrhoLvTp') {
          expect(accounts).toContain(t.tx.Account);
        }
      }
    });

    it('lists the destination of every successful Payment', () => {
      const payments = txs.filter(
        (t) => t.tx.TransactionType === 'Payment' && t.meta.TransactionResult === 'tesSUCCESS',
      );

      expect(payments.length).toBeGreaterThan(0);
      for (const t of payments) expect(parser.parse(t)).toContain(t.tx.Destination);
    });
  });

  it('includes the failed transactions of the mock ledgers: tec results touch accounts', () => {
    const failed = txsOf('xrpl', 'ripple-mock').filter((t) => t.meta.TransactionResult.startsWith('tec'));

    expect(failed).toHaveLength(19);
    for (const t of failed) expect(parser.parse(t)).toContain(t.tx.Account);
  });
});
