import { readFileSync } from 'fs';
import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { ImportParser, ParsedImport } from './import.parser';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';

type Json = Record<string, any>;

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const XAHAU: ParseContext = parseContextFor(getNetworkProfile('xahau'));
const XRPL: ParseContext = parseContextFor(getNetworkProfile('xrpl'));

const mintSource = FixtureLedgerSource.fromDir(join(FIXTURES, 'xahau', 'mint'));
const mintManifest = JSON.parse(readFileSync(join(FIXTURES, 'xahau', 'mint', 'manifest.json'), 'utf8')) as {
  cases: Record<string, { ledger: number; hash: string }>;
};

const CREATOR = 'rBPKXGERk7KrzZDGXscchv4eQoS2k6nV6M';
const EXISTING = 'rTeLeproT3BVgjWoYrDYpKbBLXPaVMkge';
const OTHER = 'rOtherOtherOtherOtherOtherOtherxx';

const parser = new ImportParser();

/** A recorded case of `xahau/mint` by its manifest name, deep-frozen. */
function mintCase(name: string): ParserTx {
  const c = mintManifest.cases[name];
  if (!c) throw new Error(`no case ${name} in the xahau/mint manifest`);
  const ledger = mintSource.list().find((l) => l.header.ledger_index === c.ledger);
  const raw = ledger?.transactions.find((t) => t.hash === c.hash);
  if (!ledger || !raw) throw new Error(`${name}: ${c.hash} is not in ledger ${c.ledger}`);
  return deepFreeze(toParserTx(raw, ledger.header, null));
}

/** A deep-frozen copy of `t` after `edit` changed (copies of) its transaction and metadata. */
function variant(t: ParserTx, edit: (tx: Json, meta: Json) => void): ParserTx {
  const tx = structuredClone(t.tx) as Json;
  const meta = structuredClone(t.meta) as Json;
  edit(tx, meta);
  return deepFreeze({ ...t, tx, meta });
}

/** The body (the contents of `ModifiedNode`, ...) of the AccountRoot node of `account`. */
function accountRoot(meta: Json, account: string): Json {
  for (const wrapper of meta.AffectedNodes as Json[]) {
    const body = Object.values(wrapper)[0] as Json;
    const fields = body.NewFields ?? body.FinalFields;
    if (body.LedgerEntryType === 'AccountRoot' && fields?.Account === account) return body;
  }
  throw new Error(`no AccountRoot node of ${account}`);
}

/** The recorded Import into an existing account, with its AccountRoot's balances (and the Import's Fee) set. */
function existing(final: string, previous: string | undefined, fee: string | null = '100'): ParserTx {
  return variant(mintCase('import-existing-account'), (tx, meta) => {
    const root = accountRoot(meta, EXISTING);
    root.FinalFields.Balance = final;
    if (previous === undefined) delete root.PreviousFields.Balance;
    else root.PreviousFields.Balance = previous;
    if (fee === null) delete tx.Fee;
    else tx.Fee = fee;
  });
}

const imported = (over: Partial<ParsedImport>): ParsedImport => ({
  account: EXISTING,
  minted: '0',
  account_created: false,
  negative: false,
  ...over,
});

describe('ImportParser', () => {
  describe('the recorded Imports', () => {
    it('mints the new balance of an Import that creates its account', () => {
      const t = mintCase('import-creates-account');
      const node = accountRoot(t.meta, CREATOR);

      // xahaud requires Fee 0 of an Import into an account that does not exist (Import.cpp:1001-1002), so Balance + Fee is Balance.
      expect(t.tx.Fee).toBe('0');
      expect(node.NewFields.Balance).toBe('2000000');
      expect(parser.parse(t, XAHAU)).toStrictEqual({
        account: CREATOR,
        minted: '2000000',
        account_created: true,
        negative: false,
      });
    });

    it('mints the balance change plus the fee of an Import into an account', () => {
      const t = mintCase('import-existing-account');
      const node = accountRoot(t.meta, EXISTING);

      // 999911 - 1000000 + 100: the account paid the fee and was credited 11 (FINDINGS fact 4).
      expect(t.tx.Fee).toBe('100');
      expect(node.FinalFields.Balance).toBe('999911');
      expect(node.PreviousFields.Balance).toBe('1000000');
      expect(parser.parse(t, XAHAU)).toStrictEqual({
        account: EXISTING,
        minted: '11',
        account_created: false,
        negative: false,
      });
    });

    it('reads only the node of the transaction Account: a FeeSettings node and a node of another account change nothing', () => {
      const t = mintCase('import-creates-account');
      const nodeTypes = (t.meta.AffectedNodes as Json[]).map((w) => (Object.values(w)[0] as Json).LedgerEntryType);

      expect(nodeTypes).toContain('FeeSettings');
      expect(parser.parse(t, XAHAU)?.minted).toBe('2000000');

      const withOther = variant(t, (_tx, meta) => {
        meta.AffectedNodes.unshift({
          ModifiedNode: {
            LedgerEntryType: 'AccountRoot',
            FinalFields: { Account: OTHER, Balance: '5000000' },
            PreviousFields: { Balance: '1000000' },
          },
        });
      });
      expect(parser.parse(withOther, XAHAU)?.minted).toBe('2000000');
    });
  });

  describe('the balance of the account node', () => {
    it('mints the fee alone for a ModifiedNode without Balance in PreviousFields', () => {
      expect(parser.parse(existing('999900', undefined), XAHAU)).toStrictEqual(imported({ minted: '100' }));
    });

    it('mints the fee alone when the account node is missing (impossible by xahaud F5)', () => {
      const t = variant(mintCase('import-existing-account'), (_tx, meta) => {
        meta.AffectedNodes = meta.AffectedNodes.filter(
          (w: Json) => (Object.values(w)[0] as Json).LedgerEntryType !== 'AccountRoot',
        );
      });

      expect(parser.parse(t, XAHAU)).toStrictEqual(imported({ minted: '100' }));
    });

    it('mints the fee alone when the node of the account was only threaded (a ModifiedNode without PreviousFields)', () => {
      const t = variant(mintCase('import-existing-account'), (_tx, meta) => {
        delete accountRoot(meta, EXISTING).PreviousFields;
      });

      expect(parser.parse(t, XAHAU)).toStrictEqual(imported({ minted: '100' }));
    });

    it('mints the fee alone when the AccountRoot node of the account was deleted', () => {
      const t = variant(mintCase('import-existing-account'), (_tx, meta) => {
        const wrapper = meta.AffectedNodes.find((w: Json) => w.ModifiedNode?.LedgerEntryType === 'AccountRoot');
        wrapper.DeletedNode = wrapper.ModifiedNode;
        delete wrapper.ModifiedNode;
      });

      expect(parser.parse(t, XAHAU)).toStrictEqual(imported({ minted: '100' }));
    });

    it('mints the fee of a created account whose node has no Balance (a default is not listed)', () => {
      const t = variant(mintCase('import-creates-account'), (_tx, meta) => {
        delete accountRoot(meta, CREATOR).NewFields.Balance;
      });

      expect(parser.parse(t, XAHAU)).toStrictEqual({
        account: CREATOR,
        minted: '0',
        account_created: true,
        negative: false,
      });
    });

    it('adds the fee to the new balance of a created account too', () => {
      const t = variant(mintCase('import-creates-account'), (tx) => {
        tx.Fee = '12';
      });

      expect(parser.parse(t, XAHAU)?.minted).toBe('2000012');
    });

    it('keeps a zero result as 0 without flagging it', () => {
      expect(parser.parse(existing('999900', '1000000'), XAHAU)).toStrictEqual(imported({ minted: '0' }));
    });
  });

  describe('a negative result', () => {
    it('clamps a negative result to 0 and flags it', () => {
      // 999000 - 1000000 + 100 = -900: cannot happen by xahaud F5.
      expect(parser.parse(existing('999000', '1000000'), XAHAU)).toStrictEqual(
        imported({ minted: '0', negative: true }),
      );
    });

    it('flags a result that is negative by one drop', () => {
      expect(parser.parse(existing('999899', '1000000'), XAHAU)).toStrictEqual(
        imported({ minted: '0', negative: true }),
      );
    });
  });

  describe('exact decimals', () => {
    it('writes the minted drops as plain digits past 2^53, with no exponent', () => {
      // 10^17 drops is the native cap; these balances are not representable as doubles.
      const t = existing('100000000000000001', '90071992547409931', '25');

      expect(parser.parse(t, XAHAU)?.minted).toBe('9928007452590095');
    });

    it('reads a balance at the cap exactly', () => {
      const t = variant(mintCase('import-creates-account'), (_tx, meta) => {
        accountRoot(meta, CREATOR).NewFields.Balance = '100000000000000000';
      });

      expect(parser.parse(t, XAHAU)?.minted).toBe('100000000000000000');
    });
  });

  describe('malformed fields never throw', () => {
    it('reads a Fee that is missing or not digits as 0', () => {
      expect(parser.parse(existing('1000011', '1000000', null), XAHAU)).toStrictEqual(imported({ minted: '11' }));
    });

    it.each(['x', '1.5', '-3', '1e3', ''])('reads a Fee of %j as 0', (fee) => {
      expect(parser.parse(existing('1000011', '1000000', fee), XAHAU)?.minted).toBe('11');
    });

    it('reads a balance that is not a string of digits as no change', () => {
      const t = variant(mintCase('import-existing-account'), (_tx, meta) => {
        accountRoot(meta, EXISTING).FinalFields.Balance = { currency: 'XAH' };
      });

      expect(parser.parse(t, XAHAU)).toStrictEqual(imported({ minted: '100' }));
    });

    it('reads an Import without Account as the fee alone, of the account ""', () => {
      const t = variant(mintCase('import-existing-account'), (tx) => {
        delete tx.Account;
      });

      expect(parser.parse(t, XAHAU)).toStrictEqual(imported({ account: '', minted: '100' }));
    });
  });

  describe('what gives nothing', () => {
    it('gives nothing for an Import that did not succeed', () => {
      for (const result of ['tecNO_PERMISSION', 'tefPAST_SEQ', 'temMALFORMED', 'terNO_ACCOUNT']) {
        const t = variant(mintCase('import-existing-account'), (_tx, meta) => {
          meta.TransactionResult = result;
        });

        expect(parser.parse(t, XAHAU)).toBeUndefined();
      }
    });

    it('gives nothing for another type, whatever its metadata says', () => {
      const t = variant(mintCase('import-existing-account'), (tx) => {
        tx.TransactionType = 'Payment';
      });

      expect(parser.parse(t, XAHAU)).toBeUndefined();
    });

    it('gives nothing for any other transaction of the Xahau recordings', () => {
      let others = 0;
      for (const source of [mintSource, FixtureLedgerSource.fromDir(join(FIXTURES, 'xahau', 'recorded'))]) {
        for (const ledger of source.list()) {
          for (const raw of ledger.transactions.filter((r) => r.tx.TransactionType !== 'Import')) {
            expect(parser.parse(deepFreeze(toParserTx(raw, ledger.header, null)), XAHAU)).toBeUndefined();
            others++;
          }
        }
      }

      expect(others).toBeGreaterThan(200);
    });

    it('gives nothing for every transaction of xrpl/recorded and xrpl-testnet/recorded', () => {
      const transactions = ['xrpl/recorded', 'xrpl-testnet/recorded'].flatMap((dir) =>
        FixtureLedgerSource.fromDir(join(FIXTURES, dir))
          .list()
          .flatMap((ledger) => ledger.transactions.map((raw) => deepFreeze(toParserTx(raw, ledger.header, null)))),
      );

      expect(transactions.length).toBeGreaterThan(1000);
      for (const t of transactions) {
        expect(parser.parse(t, XRPL)).toBeUndefined();
      }
    });
  });

  describe('purity', () => {
    it('leaves its deep-frozen input as it was', () => {
      for (const name of ['import-creates-account', 'import-existing-account']) {
        const t = mintCase(name);
        const before = JSON.stringify(t);

        expect(Object.isFrozen(t.meta)).toBe(true);
        expect(() => parser.parse(t, XAHAU)).not.toThrow();
        expect(JSON.stringify(t)).toBe(before);
      }
    });
  });
});
