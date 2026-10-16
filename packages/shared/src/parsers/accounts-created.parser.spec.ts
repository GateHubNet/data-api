import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { AccountsCreatedParser } from './accounts-created.parser';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

const XRPL: ParseContext = parseContextFor(getNetworkProfile('xrpl'));
const XAHAU: ParseContext = parseContextFor(getNetworkProfile('xahau'));

type Json = Record<string, any>;

const parser = new AccountsCreatedParser();

function parserTx(tx: Json, nodes: Json[], meta: Json = {}): ParserTx {
  return deepFreeze({
    hash: 'HASH',
    ledger_index: 100,
    close_time: 1_700_000_000,
    tx_index: 0,
    client: null,
    tx: { TransactionType: 'Payment', Account: 'rParent', Destination: 'rChild', Amount: '20000000', Fee: '12', ...tx },
    meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: nodes, ...meta },
  });
}

const created = (fields: Json, entry = 'AccountRoot'): Json => ({
  CreatedNode: { LedgerEntryType: entry, NewFields: fields },
});

const ledgers = (...parts: string[]) => FixtureLedgerSource.fromDir(join(FIXTURES, ...parts)).list();

/** Every account created in the ledgers with where it happened, ascending by ledger and transaction. */
function createdIn(dir: string[], ctx: ParseContext) {
  return ledgers(...dir).flatMap((ledger) =>
    ledger.transactions.flatMap((raw) => {
      const t = toParserTx(raw, ledger.header, null);
      return parser.parse(t, ctx).map((account) => ({ account, t }));
    }),
  );
}

describe('AccountsCreatedParser', () => {
  it('lists the accounts a transaction created, with the sender as parent and the balance in whole units', () => {
    const t = parserTx({}, [
      { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: 'rParent', Balance: '1' } } },
      created({ Account: 'rChild', Balance: '20000000', Sequence: 1 }),
      created({ Account: 'rOther', Balance: '1', Sequence: 1 }),
    ]);

    expect(parser.parse(t, XRPL)).toStrictEqual([
      { account: 'rChild', parent: 'rParent', initial_balance: '20' },
      { account: 'rOther', parent: 'rParent', initial_balance: '0.000001' },
    ]);
  });

  it('is the same on Xahau: drops are drops', () => {
    const t = parserTx({}, [created({ Account: 'rChild', Balance: '1234567', Sequence: 1 })]);

    expect(parser.parse(t, XAHAU)).toStrictEqual([
      { account: 'rChild', parent: 'rParent', initial_balance: '1.234567' },
    ]);
  });

  it('keeps balances exact beyond 2^53 drops', () => {
    const t = parserTx({}, [created({ Account: 'rChild', Balance: '9007199254740993' })]);

    expect(parser.parse(t, XRPL)[0].initial_balance).toBe('9007199254.740993');
  });

  it('skips AMM pseudo-accounts, with or without a Balance', () => {
    const t = parserTx({ TransactionType: 'AMMCreate' }, [
      created({ Account: 'rAmm1', AMMID: 'AB', Flags: 26214400 }),
      created({ Account: 'rAmm2', AMMID: 'CD', Balance: '10000000' }),
      created({ Account: 'rReal', Balance: '5000000' }),
    ]);

    expect(parser.parse(t, XRPL).map((a) => a.account)).toEqual(['rReal']);
  });

  it('starts an account that was created without a Balance at 0', () => {
    expect(parser.parse(parserTx({}, [created({ Account: 'rChild' })]), XRPL)).toStrictEqual([
      { account: 'rChild', parent: 'rParent', initial_balance: '0' },
    ]);
  });

  it('only counts accounts: other created entries and modified accounts are not creations', () => {
    const t = parserTx({}, [
      created({ Account: 'rParent', Destination: 'rChild', Amount: '1' }, 'Escrow'),
      created({ Owner: 'rChild' }, 'DirectoryNode'),
      { DeletedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: 'rGone', Balance: '0' } } },
      { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: 'rKept', Balance: '5' } } },
    ]);

    expect(parser.parse(t, XRPL)).toEqual([]);
  });

  it.each(['tecNO_DST_INSUF_XRP', 'tecPATH_DRY', 'tefPAST_SEQ', 'terQUEUED'])('%s creates nothing', (result) => {
    const t = parserTx({}, [created({ Account: 'rChild', Balance: '20000000' })], { TransactionResult: result });

    expect(parser.parse(t, XRPL)).toEqual([]);
  });

  it('names the zero account as the parent of a transaction whose Account is "" (a pseudo-transaction, ruling R95)', () => {
    const t = parserTx({ TransactionType: 'UNLReport', Account: '', Fee: '0' }, [
      created({ Account: 'rChild', Balance: '1', Sequence: 1 }),
    ]);
    expect(parser.parse(t, XAHAU)).toStrictEqual([
      { account: 'rChild', parent: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', initial_balance: '0.000001' },
    ]);
  });

  it('handles a transaction without nodes', () => {
    expect(parser.parse(parserTx({}, []), XRPL)).toEqual([]);
    expect(parser.parse(parserTx({}, undefined as unknown as Json[]), XRPL)).toEqual([]);
  });

  it('does not mutate frozen input', () => {
    const t = parserTx({}, [created({ Account: 'rChild', Balance: '20000000' })]);
    const before = JSON.stringify(t);

    expect(() => parser.parse(t, XRPL)).not.toThrow();
    expect(JSON.stringify(t)).toBe(before);
  });

  // The original Ripple Data API's test.accounts.js lists the accounts created in the 54 mock ledgers: 13 of them,
  // nine on 2013-06-11 (ledger 1021029), three by rMTzGg7n… (ledger 2964124) and one later.
  describe('ripple-mock ledgers', () => {
    const all = createdIn(['xrpl', 'ripple-mock'], XRPL);

    it('accounts created in 1021029-accounts_created.json', () => {
      const here = all.filter(({ t }) => t.ledger_index === 1021029).sort((a, b) => a.t.tx_index - b.t.tx_index);

      expect(here).toHaveLength(9);
      // The first account, in ledger and transaction order.
      expect(here[0].account).toStrictEqual({
        account: 'rHTaDFHJng6YVtThvv522LmJfkocBVkK6Z',
        parent: 'rJR7gjNe3DpJ7kpB4CHBxjDKfwVMpTKPpj',
        initial_balance: '1000',
      });
      expect(here[0].t).toMatchObject({
        tx_index: 0,
        hash: 'E011E6D20BE1FAC7C37F2FA0D36F0811C404B118D936963051600796FF2C0CBC',
      });
      // Ripple's Link header for ?limit=1 points at the second one: marker 20130611200120|000001021029|00001.
      expect(here[1].t).toMatchObject({ ledger_index: 1021029, tx_index: 1 });
      expect(here[1].account.account).toBe('rGTvj2qFEYunK7vnWeWmxwvTcL2svvVP7b');
      expect(new Date(here[1].t.close_time * 1000).toISOString()).toBe('2013-06-11T20:01:20.000Z');
      for (const { account } of here) {
        expect(account.parent).toBe('rJR7gjNe3DpJ7kpB4CHBxjDKfwVMpTKPpj');
        expect(account.initial_balance).toBe('1000');
      }
    });

    it('creates 13 accounts in all 54 mock ledgers, in ledger order', () => {
      expect(all).toHaveLength(13);
      const positions = all.map(({ t }) => t.ledger_index);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(new Set(all.map(({ account }) => account.account)).size).toBe(13);
    });

    it('creates 9 accounts between 2013-01-14T18:28:40 and 2013-07-01', () => {
      const from = Date.UTC(2013, 0, 14, 18, 28, 40) / 1000;
      const to = Date.UTC(2013, 6, 1) / 1000;

      expect(all.filter(({ t }) => t.close_time >= from && t.close_time <= to)).toHaveLength(9);
    });

    it('creates 3 accounts for rMTzGg7nPPEMJthjgEBfiPZGoAM7MEVa1r (ledger 2964124)', () => {
      const children = all.filter(({ account }) => account.parent === 'rMTzGg7nPPEMJthjgEBfiPZGoAM7MEVa1r');

      expect(children).toHaveLength(3);
      expect(children.every(({ t }) => t.ledger_index === 2964124)).toBe(true);
      expect(children.map(({ account }) => account.initial_balance)).toEqual(['888', '888', '888']);
    });

    it('knows rGTvj2qFEYunK7vnWeWmxwvTcL2svvVP7b: one creation, with a parent and a balance', () => {
      const found = all.filter(({ account }) => account.account === 'rGTvj2qFEYunK7vnWeWmxwvTcL2svvVP7b');

      expect(found).toHaveLength(1);
      expect(found[0].account.parent).toMatch(/^r/);
      expect(typeof found[0].account.initial_balance).toBe('string');
    });
  });

  describe('recorded ledgers', () => {
    it('creates no account from an AMMCreate: its pseudo-account is skipped', () => {
      const ammCreate = ledgers('xrpl', 'recorded')
        .flatMap((l) => l.transactions.map((raw) => toParserTx(raw, l.header, null)))
        .find((t) => t.tx.TransactionType === 'AMMCreate');
      expect(ammCreate).toBeDefined();
      const hasAmmAccount = (ammCreate!.meta.AffectedNodes as Json[]).some(
        (n) => n.CreatedNode?.LedgerEntryType === 'AccountRoot' && 'AMMID' in n.CreatedNode.NewFields,
      );
      expect(hasAmmAccount).toBe(true);
      expect(parser.parse(ammCreate!, XRPL)).toEqual([]);
    });
  });
});
