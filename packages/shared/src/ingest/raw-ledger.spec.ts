import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { FixtureLedgerSource } from './fixture-ledger-source';
import { LedgerNotAvailableError } from './ledger-source';
import { normalizeLedgerResponse, RawLedger } from './raw-ledger';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const MOCK_DIR = join(FIXTURES, 'xrpl', 'ripple-mock');
const RIPPLE_EPOCH_S = 946684800;

function loadMock(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MOCK_DIR, name), 'utf8')) as Record<string, unknown>;
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isDeepFrozen);
}

/** A minimal expanded rippled v1 `ledger` result.ledger as returned by xrpl.js 2.14. */
function liveLedger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_hash: 'A'.repeat(64),
    close_flags: 0,
    close_time: 750000002,
    close_time_human: '2023-Feb-06 13:20:02.000000000 UTC',
    close_time_resolution: 10,
    closed: true,
    ledger_hash: 'B'.repeat(64),
    ledger_index: '80000001',
    parent_close_time: 750000001,
    parent_hash: 'C'.repeat(64),
    total_coins: '99988000000000000',
    transaction_hash: 'D'.repeat(64),
    transactions: [
      {
        Account: 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg',
        Fee: '10',
        TransactionType: 'AccountSet',
        hash: 'E'.repeat(64),
        metaData: { AffectedNodes: [], TransactionIndex: 1, TransactionResult: 'tesSUCCESS' },
      },
      {
        Account: 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg',
        Fee: '10',
        TransactionType: 'AccountSet',
        hash: 'F'.repeat(64),
        metaData: { AffectedNodes: [], TransactionIndex: 0, TransactionResult: 'tesSUCCESS' },
      },
    ],
    ...overrides,
  };
}

describe('normalizeLedgerResponse', () => {
  describe('Ripple mock ledger 11118827', () => {
    const raw = loadMock('11118827.json');
    const ledger = normalizeLedgerResponse(raw);

    it('builds the header with numeric index and unix close times', () => {
      expect(ledger.header).toEqual({
        ledger_index: 11118827,
        ledger_hash: '6C36469B9B95B84BB439713BC0D0E914728BE1DED8C19B640765E22D89D84A69',
        parent_hash: 'D18572CED3F13BA2AD7B951CB65A943181F1C0DB8FFB4B61F0C4797FBE65E1AC',
        account_hash: '421662B7A33787943607E0AE5E4B79560FC23F2839B03A4C688991159F9377BA',
        transaction_hash: 'FF44D1606F56590F9A7D57B709B80AFC78149B1E3C559BDAD00A55C96CC69E77',
        total_coins: '99999578499553817',
        close_time: 474571750 + RIPPLE_EPOCH_S,
        parent_close_time: 0,
        close_time_resolution: 10,
        close_flags: 0,
      });
      expect(typeof ledger.header.ledger_index).toBe('number');
      expect(ledger.header.close_time).toBe(474571750 + 946684800);
    });

    it('sorts transactions by meta.TransactionIndex', () => {
      expect(ledger.transactions).toHaveLength(13);
      const indexes = ledger.transactions.map((t) => t.meta.TransactionIndex as number);
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
      expect(indexes[0]).toBe(0);
    });

    it('moves hash and metadata out of tx', () => {
      for (const t of ledger.transactions) {
        expect(typeof t.hash).toBe('string');
        expect(t.tx).not.toHaveProperty('hash');
        expect(t.tx).not.toHaveProperty('metaData');
        expect(t.tx).not.toHaveProperty('meta');
        expect(t.tx).toHaveProperty('TransactionType');
        expect(t.meta).toHaveProperty('AffectedNodes');
      }
    });

    it('keeps every transaction and its hash', () => {
      const rawHashes = (raw.transactions as { hash: string }[]).map((t) => t.hash).sort();
      expect(ledger.transactions.map((t) => t.hash).sort()).toEqual(rawHashes);
    });
  });

  describe('immutability', () => {
    it('returns a deeply frozen ledger', () => {
      const ledger = normalizeLedgerResponse(loadMock('11118827.json'));
      expect(Object.isFrozen(ledger.transactions[0].meta)).toBe(true);
      expect(isDeepFrozen(ledger)).toBe(true);
      expect(() => {
        (ledger.transactions[0].tx as Record<string, unknown>).Account = 'x';
      }).toThrow(TypeError);
    });

    it('does not freeze or otherwise modify its input', () => {
      const input = liveLedger();
      const before = JSON.stringify(input);
      normalizeLedgerResponse(input);
      expect(JSON.stringify(input)).toBe(before);
      expect(Object.isFrozen(input)).toBe(false);
      expect(Object.isFrozen((input.transactions as unknown[])[0])).toBe(false);
    });
  });

  describe('input variants', () => {
    it('accepts a live rippled v1 ledger (ledger_hash, total_coins, metaData, parent_close_time)', () => {
      const ledger = normalizeLedgerResponse(liveLedger());
      expect(ledger.header).toEqual({
        ledger_index: 80000001,
        ledger_hash: 'B'.repeat(64),
        parent_hash: 'C'.repeat(64),
        account_hash: 'A'.repeat(64),
        transaction_hash: 'D'.repeat(64),
        total_coins: '99988000000000000',
        close_time: 750000002 + RIPPLE_EPOCH_S,
        parent_close_time: 750000001 + RIPPLE_EPOCH_S,
        close_time_resolution: 10,
        close_flags: 0,
      });
      expect(ledger.transactions.map((t) => t.hash)).toEqual(['F'.repeat(64), 'E'.repeat(64)]);
    });

    it('accepts a numeric ledger_index', () => {
      expect(normalizeLedgerResponse(liveLedger({ ledger_index: 80000001 })).header.ledger_index).toBe(80000001);
    });

    it('falls back from ledger_hash to hash and from total_coins to totalCoins', () => {
      const input = liveLedger({ hash: 'ABCD'.repeat(16), totalCoins: '42' });
      delete input.ledger_hash;
      delete input.total_coins;
      const { header } = normalizeLedgerResponse(input);
      expect(header.ledger_hash).toBe('ABCD'.repeat(16));
      expect(header.total_coins).toBe('42');
    });

    it('accepts tx meta instead of metaData', () => {
      const tx = {
        Account: 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg',
        TransactionType: 'AccountSet',
        hash: '1'.repeat(64),
        meta: { AffectedNodes: [], TransactionIndex: 0, TransactionResult: 'tesSUCCESS' },
      };
      const ledger = normalizeLedgerResponse(liveLedger({ transactions: [tx] }));
      expect(ledger.transactions[0].meta.TransactionResult).toBe('tesSUCCESS');
      expect(ledger.transactions[0].tx).not.toHaveProperty('meta');
    });

    it('defaults a missing parent_close_time and close_flags to 0', () => {
      const input = liveLedger();
      delete input.parent_close_time;
      delete input.close_flags;
      const { header } = normalizeLedgerResponse(input);
      expect(header.parent_close_time).toBe(0);
      expect(header.close_flags).toBe(0);
    });

    it('keeps a reported parent_close_time of 0 (genesis) as 0 instead of the ripple epoch', () => {
      expect(normalizeLedgerResponse(liveLedger({ parent_close_time: 0 })).header.parent_close_time).toBe(0);
    });

    it('handles a ledger without transactions', () => {
      expect(normalizeLedgerResponse(liveLedger({ transactions: [] })).transactions).toEqual([]);
      const input = liveLedger();
      delete input.transactions;
      expect(normalizeLedgerResponse(input).transactions).toEqual([]);
    });

    it('normalizes every Ripple mock ledger', () => {
      const names = readdirSync(MOCK_DIR).filter((n) => n.endsWith('.json'));
      expect(names).toHaveLength(54);
      for (const name of names) {
        const raw = loadMock(name);
        const ledger = normalizeLedgerResponse(raw);
        expect(ledger.header.ledger_index).toBe(Number(raw.ledger_index));
        expect(ledger.transactions).toHaveLength((raw.transactions as unknown[]).length);
        const indexes = ledger.transactions.map((t) => t.meta.TransactionIndex as number);
        expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
      }
    });
  });

  describe('invalid input', () => {
    it('rejects transactions that were not expanded', () => {
      expect(() => normalizeLedgerResponse(liveLedger({ transactions: ['E'.repeat(64)] }))).toThrow(/expand/i);
    });

    it('rejects a transaction without metadata', () => {
      const tx = { TransactionType: 'AccountSet', hash: 'E'.repeat(64) };
      expect(() => normalizeLedgerResponse(liveLedger({ transactions: [tx] }))).toThrow(/meta/i);
    });

    it('rejects a transaction without TransactionIndex, naming the transaction', () => {
      const tx = { TransactionType: 'AccountSet', hash: 'E'.repeat(64), metaData: { AffectedNodes: [] } };
      expect(() => normalizeLedgerResponse(liveLedger({ transactions: [tx] }))).toThrow(/E{64}.*TransactionIndex/);
    });

    it('rejects a transaction without a hash', () => {
      const tx = { TransactionType: 'AccountSet', metaData: { AffectedNodes: [], TransactionIndex: 0 } };
      expect(() => normalizeLedgerResponse(liveLedger({ transactions: [tx] }))).toThrow(/hash/i);
    });

    it('rejects a non-numeric ledger_index', () => {
      expect(() => normalizeLedgerResponse(liveLedger({ ledger_index: 'abc' }))).toThrow(/ledger_index/);
    });

    it('rejects a missing ledger hash', () => {
      const input = liveLedger();
      delete input.ledger_hash;
      expect(() => normalizeLedgerResponse(input)).toThrow(/hash/i);
    });
  });
});

describe('FixtureLedgerSource', () => {
  describe('fromDir(ripple-mock)', () => {
    const source = FixtureLedgerSource.fromDir(MOCK_DIR);

    it('loads all 54 mock ledgers, ascending by index', () => {
      const indexes = source.list().map((l) => l.header.ledger_index);
      expect(indexes).toHaveLength(54);
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
      expect(indexes[0]).toBe(1021029);
    });

    it('reports the highest index as the validated head', async () => {
      await expect(source.validatedHead()).resolves.toBe(29709909);
    });

    it('fetches a ledger by index', async () => {
      const ledger = await source.fetch(11118827);
      expect(ledger.header.ledger_index).toBe(11118827);
      expect(ledger.transactions).toHaveLength(13);
    });

    it('rejects fetch of an unknown index with LedgerNotAvailableError', async () => {
      await expect(source.fetch(1)).rejects.toBeInstanceOf(LedgerNotAvailableError);
      await expect(source.fetch(1)).rejects.toThrow(/\b1\b/);
    });
  });

  describe('constructor', () => {
    const ledger = (index: number): RawLedger => ({
      header: { ...normalizeLedgerResponse(liveLedger()).header, ledger_index: index },
      transactions: [],
    });

    it('sorts the ledgers and uses the maximum as head regardless of input order', async () => {
      const source = new FixtureLedgerSource([ledger(5), ledger(3), ledger(9)]);
      expect(source.list().map((l) => l.header.ledger_index)).toEqual([3, 5, 9]);
      await expect(source.validatedHead()).resolves.toBe(9);
    });

    it('rejects validatedHead when there are no ledgers', async () => {
      await expect(new FixtureLedgerSource([]).validatedHead()).rejects.toThrow(/no ledgers/i);
    });

    it('rejects duplicate indexes', () => {
      expect(() => new FixtureLedgerSource([ledger(3), ledger(3)])).toThrow(/duplicate/i);
    });

    it('does not let callers change the list through list()', () => {
      const source = new FixtureLedgerSource([ledger(3)]);
      source.list().pop();
      expect(source.list()).toHaveLength(1);
    });
  });

  describe('fromDir with recorded files', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'fixture-ledger-source-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads .json.gz files holding a full rippled result and unwraps result.ledger', async () => {
      const result = {
        ledger: liveLedger({ ledger_index: '80000001' }),
        ledger_hash: 'B'.repeat(64),
        ledger_index: 80000001,
        validated: true,
      };
      writeFileSync(join(dir, '80000001.json.gz'), gzipSync(JSON.stringify(result)));
      const source = FixtureLedgerSource.fromDir(dir);
      const ledger = await source.fetch(80000001);
      expect(ledger.header.ledger_hash).toBe('B'.repeat(64));
      expect(ledger.transactions).toHaveLength(2);
    });

    it('reads plain .json files that hold a bare ledger and mixes both kinds', async () => {
      writeFileSync(join(dir, '80000001.json'), JSON.stringify(liveLedger({ ledger_index: '80000001' })));
      writeFileSync(
        join(dir, '80000002.json.gz'),
        gzipSync(JSON.stringify({ ledger: liveLedger({ ledger_index: '80000002' }) })),
      );
      const source = FixtureLedgerSource.fromDir(dir);
      expect(source.list().map((l) => l.header.ledger_index)).toEqual([80000001, 80000002]);
      await expect(source.validatedHead()).resolves.toBe(80000002);
    });

    it('ignores files that are not ledgers (server_info.json, README.md, ...)', () => {
      writeFileSync(join(dir, '80000001.json'), JSON.stringify(liveLedger({ ledger_index: '80000001' })));
      writeFileSync(join(dir, 'server_info.json'), JSON.stringify({ info: {} }));
      writeFileSync(join(dir, 'server_definitions.json'), JSON.stringify({ TYPES: {} }));
      writeFileSync(join(dir, 'README.md'), '# notes');
      expect(FixtureLedgerSource.fromDir(dir).list()).toHaveLength(1);
    });

    it('fails with the file name when a ledger file cannot be normalized', () => {
      writeFileSync(join(dir, '80000001.json'), JSON.stringify({ ledger_index: '80000001' }));
      expect(() => FixtureLedgerSource.fromDir(dir)).toThrow(/80000001\.json/);
    });
  });
});

describe.each([
  ['xrpl', join(FIXTURES, 'xrpl', 'recorded')],
  ['xahau', join(FIXTURES, 'xahau', 'recorded')],
])('recorded %s fixtures', (network, dir) => {
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => /^\d+.*\.json(\.gz)?$/.test(n)) : [];
  const run = files.length > 0 ? describe : describe.skip;

  run('when present', () => {
    it('all normalize and are deep-frozen with sorted transactions', () => {
      const source = FixtureLedgerSource.fromDir(dir);
      expect(source.list()).toHaveLength(files.length);
      for (const ledger of source.list()) {
        expect(isDeepFrozen(ledger)).toBe(true);
        const indexes = ledger.transactions.map((t) => t.meta.TransactionIndex as number);
        expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
        for (const t of ledger.transactions) {
          expect(t.tx).not.toHaveProperty('hash');
          expect(t.tx).not.toHaveProperty('metaData');
          expect(t.tx).not.toHaveProperty('meta');
        }
      }
    });
  });

  if (files.length === 0) {
    it.skip(`${network}: no recorded fixtures in ${dir}`, () => undefined);
  }
});
