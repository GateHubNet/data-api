import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { Options, parseArgs, RecorderNode, recordFixtures, UsageError } from './record-fixtures';

const HASH_A = 'A'.repeat(64);
const HASH_B = 'B'.repeat(63) + '1';
const HASH_C = 'C'.repeat(64);
const HASH_UNKNOWN = 'D'.repeat(63) + '9';

interface StubTx {
  hash: string;
  ledger: number;
  type?: string;
  result?: string;
  validated?: boolean;
}

/** A rippled error as xrpl.js raises it: `message` is the server's `error_message`, the whole response is in `data`. */
function rippledError(error: string, message: string): Error {
  return Object.assign(new Error(message), { data: { status: 'error', error, error_message: message } });
}

/**
 * A node holding the given transactions. A ledger holds every stub transaction of that ledger, so two hashes with the same
 * `ledger` end up in the same recorded ledger.
 */
function stubNode(txs: StubTx[], head = 1000) {
  const calls: Record<string, unknown>[] = [];
  const times: number[] = [];
  const ledgerOf = (index: number) => ({
    ledger: {
      ledger_index: String(index),
      transactions: txs
        .filter((t) => t.ledger === index)
        .map((t) => ({
          hash: t.hash,
          TransactionType: t.type ?? 'Payment',
          metaData: { TransactionResult: t.result ?? 'tesSUCCESS' },
        })),
    },
    ledger_index: index,
    validated: true,
  });
  const node: RecorderNode = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    request: async (command) => {
      calls.push(command);
      times.push(Date.now());
      switch (command.command) {
        case 'server_info':
          return { info: { validated_ledger: { seq: head } } };
        case 'server_definitions':
          return { FIELDS: [] };
        case 'tx': {
          const tx = txs.find((t) => t.hash === String(command.transaction).toUpperCase());
          if (!tx) throw rippledError('txnNotFound', 'Transaction not found.');
          return {
            hash: tx.hash,
            TransactionType: tx.type ?? 'Payment',
            ledger_index: tx.ledger,
            meta: { TransactionResult: tx.result ?? 'tesSUCCESS' },
            validated: tx.validated ?? true,
          };
        }
        case 'ledger':
          return ledgerOf(Number(command.ledger_index));
        default:
          throw new Error(`unexpected command ${String(command.command)}`);
      }
    },
  };
  return { node, calls, times, commands: (name: string) => calls.filter((c) => c.command === name) };
}

describe('record-fixtures', () => {
  let out: string;
  const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'record-fixtures-spec-'));
  });
  afterEach(() => {
    // `out` was created by this test, and so was everything in it.
    rmSync(out, { recursive: true, force: true });
  });

  const options = (extra: Partial<Options>): Options => ({
    network: 'xrpl',
    endpoint: 'wss://stub.invalid',
    out,
    ledgers: [],
    want: [],
    scan: 0,
    delayMs: 0,
    anyResult: false,
    txs: [],
    ...extra,
  });
  const readJson = (name: string) => JSON.parse(readFileSync(join(out, name), 'utf8'));
  const readLedger = (index: number) => JSON.parse(gunzipSync(readFileSync(join(out, `${index}.json.gz`))).toString());
  const baseArgs = ['--network', 'xrpl', '--endpoint', 'wss://stub.invalid', '--out', '/nowhere'];

  describe('parseArgs', () => {
    it('reads --txs as a comma-separated list of transaction hashes, upper-cased', () => {
      const parsed = parseArgs([...baseArgs, '--txs', `${HASH_A.toLowerCase()}, ${HASH_B}`]);
      expect(parsed.txs).toEqual([HASH_A, HASH_B]);
    });

    it('accepts --txs on its own', () => {
      expect(() => parseArgs([...baseArgs, '--txs', HASH_A])).not.toThrow();
    });

    it('defaults --txs to none and still wants --ledgers or --want', () => {
      expect(parseArgs([...baseArgs, '--ledgers', '5']).txs).toEqual([]);
      expect(() => parseArgs(baseArgs)).toThrow(/give --ledgers and\/or --want and\/or --txs/);
    });

    it('rejects a value that is not a 64-digit hex transaction hash and names it', () => {
      expect(() => parseArgs([...baseArgs, '--txs', `${HASH_A},12345`])).toThrow(UsageError);
      expect(() => parseArgs([...baseArgs, '--txs', `${HASH_A},12345`])).toThrow(/"12345"/);
    });

    it('still rejects unknown options', () => {
      expect(() => parseArgs([...baseArgs, '--nope', '1'])).toThrow(/unknown option --nope/);
    });
  });

  describe('--txs', () => {
    it('resolves each hash to its ledger and records it once', async () => {
      const { node, commands } = stubNode([
        { hash: HASH_A, ledger: 500, type: 'AMMDeposit' },
        { hash: HASH_B, ledger: 500, type: 'Payment' },
        { hash: HASH_C, ledger: 600, type: 'OfferCreate' },
      ]);

      const run = await recordFixtures(options({ txs: [HASH_A, HASH_B, HASH_C] }), node, silent);

      expect(run.failure).toBeUndefined();
      expect(commands('tx').map((c) => c.transaction)).toEqual([HASH_A, HASH_B, HASH_C]);
      expect(commands('ledger').map((c) => c.ledger_index)).toEqual([500, 600]);
      expect(readdirSync(out).filter((f) => f.endsWith('.json.gz'))).toEqual(['500.json.gz', '600.json.gz']);
      expect(readLedger(500).ledger.transactions.map((t: { hash: string }) => t.hash)).toEqual([HASH_A, HASH_B]);
      const manifest = readJson('manifest.json');
      expect(manifest.ledgers.map((l: { ledger: number }) => l.ledger)).toEqual([500, 600]);
      expect(manifest.txs).toEqual({
        [HASH_A]: { ledger: 500, type: 'AMMDeposit', result: 'tesSUCCESS' },
        [HASH_B]: { ledger: 500, type: 'Payment', result: 'tesSUCCESS' },
        [HASH_C]: { ledger: 600, type: 'OfferCreate', result: 'tesSUCCESS' },
      });
      expect(manifest.complete).toBe(true);
    });

    it('does not fetch a ledger again that --ledgers already recorded', async () => {
      const { node, commands } = stubNode([{ hash: HASH_A, ledger: 500 }]);

      const run = await recordFixtures(options({ ledgers: [500], txs: [HASH_A] }), node, silent);

      expect(run.failure).toBeUndefined();
      expect(commands('tx')).toHaveLength(1);
      expect(commands('ledger')).toHaveLength(1);
      const manifest = readJson('manifest.json');
      expect(manifest.ledgers).toHaveLength(1);
      expect(manifest.txs[HASH_A]).toEqual({ ledger: 500, type: 'Payment', result: 'tesSUCCESS' });
    });

    it('records a repeated hash once', async () => {
      const { node, commands } = stubNode([{ hash: HASH_A, ledger: 500 }]);

      await recordFixtures(options({ txs: [HASH_A, HASH_A] }), node, silent);

      expect(commands('ledger')).toHaveLength(1);
    });

    it('answers a hash the node does not know with an error that names it, without retrying', async () => {
      const { node, commands } = stubNode([{ hash: HASH_A, ledger: 500 }]);
      const errors: string[] = [];

      const run = await recordFixtures(options({ txs: [HASH_A, HASH_UNKNOWN] }), node, {
        ...silent,
        error: (m) => errors.push(m),
      });

      expect(run.failure).toBeInstanceOf(Error);
      expect((run.failure as Error).message).toContain(HASH_UNKNOWN);
      expect((run.failure as Error).message).toMatch(/txnNotFound|not found/i);
      expect(errors.join('\n')).toContain(HASH_UNKNOWN);
      expect(commands('tx').filter((c) => c.transaction === HASH_UNKNOWN)).toHaveLength(1);
      // The work done before the bad hash is kept and the manifest says the run did not finish.
      expect(existsSync(join(out, '500.json.gz'))).toBe(true);
      expect(readJson('manifest.json').complete).toBe(false);
    });

    it('refuses a transaction that is not in a validated ledger yet', async () => {
      const { node, commands } = stubNode([{ hash: HASH_A, ledger: 500, validated: false }]);

      const run = await recordFixtures(options({ txs: [HASH_A] }), node, silent);

      expect((run.failure as Error).message).toContain(HASH_A);
      expect((run.failure as Error).message).toMatch(/not validated/i);
      expect(commands('ledger')).toHaveLength(0);
    });

    it('refuses a ledger that does not hold the transaction the node said it was in', async () => {
      const { node } = stubNode([{ hash: HASH_A, ledger: 500 }]);
      const lying: RecorderNode = {
        ...node,
        request: async (command) =>
          command.command === 'tx' ? { ...(await node.request(command)), ledger_index: 501 } : node.request(command),
      };

      const run = await recordFixtures(options({ txs: [HASH_A] }), lying, silent);

      expect((run.failure as Error).message).toContain(HASH_A);
      expect((run.failure as Error).message).toContain('501');
    });

    it('keeps the hand-written cases of an earlier manifest when it rewrites the manifest', async () => {
      const cases = { swap_payment_xrp_iou: { ledger: 500, hash: HASH_A, type: 'Payment', note: 'kept' } };
      writeFileSync(join(out, 'manifest.json'), JSON.stringify({ cases, found: { Old: {} } }));
      const { node } = stubNode([{ hash: HASH_A, ledger: 500 }]);

      await recordFixtures(options({ txs: [HASH_A] }), node, silent);

      const manifest = readJson('manifest.json');
      expect(manifest.cases).toEqual(cases);
      expect(manifest.found).toEqual({});
    });

    it('adds to the manifest of an earlier run: the txs, ledgers and cases of both runs are kept', async () => {
      const { node } = stubNode([
        { hash: HASH_A, ledger: 500, type: 'AMMDeposit' },
        { hash: HASH_B, ledger: 600, type: 'Payment' },
      ]);
      await recordFixtures(options({ txs: [HASH_A] }), node, silent);
      const cases = { deposit_two_asset: { ledger: 500, hash: HASH_A, type: 'AMMDeposit', note: 'hand-written' } };
      writeFileSync(join(out, 'manifest.json'), JSON.stringify({ ...readJson('manifest.json'), cases }));

      const run = await recordFixtures(options({ txs: [HASH_B] }), node, silent);

      expect(run.failure).toBeUndefined();
      const manifest = readJson('manifest.json');
      expect(manifest.txs).toEqual({
        [HASH_A]: { ledger: 500, type: 'AMMDeposit', result: 'tesSUCCESS' },
        [HASH_B]: { ledger: 600, type: 'Payment', result: 'tesSUCCESS' },
      });
      expect(manifest.ledgers.map((l: { ledger: number }) => l.ledger)).toEqual([500, 600]);
      expect(manifest.cases).toEqual(cases);
      expect(readdirSync(out).filter((f) => f.endsWith('.json.gz'))).toEqual(['500.json.gz', '600.json.gz']);
    });

    it('records a ledger of an earlier run again without listing it twice', async () => {
      const { node } = stubNode([{ hash: HASH_A, ledger: 500 }]);
      await recordFixtures(options({ txs: [HASH_A] }), node, silent);

      await recordFixtures(options({ ledgers: [500], txs: [HASH_A] }), node, silent);

      const manifest = readJson('manifest.json');
      expect(manifest.ledgers.map((l: { ledger: number }) => l.ledger)).toEqual([500]);
      expect(Object.keys(manifest.txs)).toEqual([HASH_A]);
    });

    it('drops an earlier ledger whose file is gone, with its txs, and says so', async () => {
      const { node } = stubNode([
        { hash: HASH_A, ledger: 500 },
        { hash: HASH_B, ledger: 600 },
        { hash: HASH_C, ledger: 700 },
      ]);
      await recordFixtures(options({ txs: [HASH_A, HASH_B] }), node, silent);
      rmSync(join(out, '500.json.gz'));
      const warnings: string[] = [];

      await recordFixtures(options({ txs: [HASH_C] }), node, { ...silent, warn: (m) => warnings.push(m) });

      const manifest = readJson('manifest.json');
      expect(manifest.ledgers.map((l: { ledger: number }) => l.ledger)).toEqual([600, 700]);
      expect(Object.keys(manifest.txs).sort()).toEqual([HASH_B, HASH_C].sort());
      expect(warnings.join('\n')).toContain('500');
    });

    it('starts a fresh manifest, with a warning, when the earlier one is not valid JSON', async () => {
      writeFileSync(join(out, 'manifest.json'), '{ not json');
      const { node } = stubNode([{ hash: HASH_A, ledger: 500 }]);
      const warnings: string[] = [];

      const run = await recordFixtures(options({ txs: [HASH_A] }), node, { ...silent, warn: (m) => warnings.push(m) });

      expect(run.failure).toBeUndefined();
      expect(warnings.join('\n')).toMatch(/not valid JSON/);
      expect(Object.keys(readJson('manifest.json').txs)).toEqual([HASH_A]);
    });

    it('pauses --delay-ms after every tx lookup and every ledger fetch', async () => {
      const { node, calls, times } = stubNode([
        { hash: HASH_A, ledger: 500 },
        { hash: HASH_B, ledger: 500 },
        { hash: HASH_C, ledger: 600 },
      ]);

      await recordFixtures(options({ txs: [HASH_A, HASH_B, HASH_C], delayMs: 40 }), node, silent);

      const spaced = calls
        .map((c, i) => ({ command: c.command, at: times[i] }))
        .filter((c) => c.command === 'tx' || c.command === 'ledger');
      expect(spaced.map((c) => c.command)).toEqual(['tx', 'ledger', 'tx', 'tx', 'ledger']);
      for (let i = 1; i < spaced.length; i++) expect(spaced[i].at - spaced[i - 1].at).toBeGreaterThanOrEqual(35);
    });
  });

  describe('--ledgers and --want (unchanged)', () => {
    it('records the given ledgers', async () => {
      const { node, commands } = stubNode([
        { hash: HASH_A, ledger: 700 },
        { hash: HASH_B, ledger: 701 },
      ]);

      const run = await recordFixtures(options({ ledgers: [700, 701] }), node, silent);

      expect(run.failure).toBeUndefined();
      expect(commands('ledger').map((c) => c.ledger_index)).toEqual([700, 701]);
      expect(existsSync(join(out, '700.json.gz'))).toBe(true);
      expect(existsSync(join(out, '701.json.gz'))).toBe(true);
      expect(existsSync(join(out, 'server_info.json'))).toBe(true);
      expect(readJson('manifest.json').txs).toEqual({});
    });

    it('walks back from the head and keeps only the ledger holding a wanted type', async () => {
      const { node } = stubNode([{ hash: HASH_A, ledger: 998, type: 'AMMBid' }], 1000);

      const run = await recordFixtures(options({ want: ['AMMBid', 'Clawback'], scan: 5 }), node, silent);

      expect(run.failure).toBeUndefined();
      const manifest = readJson('manifest.json');
      expect(manifest.found).toEqual({ AMMBid: { ledger: 998, hash: HASH_A } });
      expect(manifest.missing).toEqual(['Clawback']);
      expect(manifest.scanned).toBe(5);
      expect(readdirSync(out).filter((f) => f.endsWith('.json.gz'))).toEqual(['998.json.gz']);
    });
  });
});
