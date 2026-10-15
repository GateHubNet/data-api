import { getNetworkProfile, NetworkName } from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from 'ripple-binary-codec';
import {
  fixtureTransaction,
  fixtureTransactions,
  transactionId,
  XAHAU_RECORDED_DIR,
} from '../../test/support/fixtures';
import type { XrplService } from '../xrpl/xrpl.service';
import { BinaryCodecService, DEFINITIONS_RETRY_MS } from './binary-codec.service';

/** What a Xahau node answers to `server_definitions` (recorded from xahau.network). */
const XAHAU_SERVER_DEFINITIONS = JSON.parse(
  readFileSync(join(XAHAU_RECORDED_DIR, 'server_definitions.json'), 'utf8'),
) as Record<string, unknown>;

/** The mainnet Payment that the Ripple tests use (`test.transactions.js`), and a recorded Xahau ClaimReward. */
const MOCK_PAYMENT = '22F26CE4E2270CE3CF4EB61C609E7ADEDCD41D4C1BA2D96D680A9B016C4F47DA';
const XAHAU_CLAIM_REWARD = '3A1F25CDF0E2E4466AA0B019EA3039A6E5F87C01FBDD69CBDC474DAC32D8E64C';

type Request = (req: Record<string, unknown>, opts?: unknown) => unknown;

/** An XrplService whose node answers with `answer`. */
function nodeWith(answer: Request): { xrpl: XrplService; request: jest.Mock } {
  const request = jest.fn(async (req: Record<string, unknown>, opts?: unknown) => answer(req, opts));
  return { xrpl: { request } as unknown as XrplService, request };
}

const nodeDown = (): ReturnType<typeof nodeWith> =>
  nodeWith(() => {
    throw new Error('No node connection');
  });

async function started(
  network: NetworkName,
  node: ReturnType<typeof nodeWith>,
): Promise<{ codec: BinaryCodecService; request: jest.Mock }> {
  const codec = new BinaryCodecService(node.xrpl, getNetworkProfile(network));
  await codec.onModuleInit();
  return { codec, request: node.request };
}

describe('BinaryCodecService', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('definitions', () => {
    it("asks the node for server_definitions (no api_version) and uses its answer, whatever the network's own fallback is", async () => {
      // The xrpl profile has no fallback and the built-in definitions know no ClaimReward: only the node's answer encodes it.
      const { codec, request } = await started(
        'xrpl',
        nodeWith(() => XAHAU_SERVER_DEFINITIONS),
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toEqual({ command: 'server_definitions' });
      expect(codec.definitionsSource).toBe('node');
      expect(warn).not.toHaveBeenCalled();
      const { tx } = fixtureTransaction('xahau-recorded', XAHAU_CLAIM_REWARD);
      expect(transactionId(codec.encode(tx.tx))).toBe(XAHAU_CLAIM_REWARD);
    });

    it("falls back to the network profile's bundled definitions when the node cannot answer", async () => {
      const { codec } = await started('xahau', nodeDown());
      expect(codec.definitionsSource).toBe('profile');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('bundled xahau definitions'));
      const { tx } = fixtureTransaction('xahau-recorded', XAHAU_CLAIM_REWARD);
      expect(transactionId(codec.encode(tx.tx))).toBe(XAHAU_CLAIM_REWARD);
    });

    it("falls back to the codec's built-in definitions when the node cannot answer and the profile has none", async () => {
      const { codec } = await started('xrpl', nodeDown());
      expect(codec.definitionsSource).toBe('builtin');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('built-in definitions'));
      const { tx } = fixtureTransaction('ripple-mock', MOCK_PAYMENT);
      expect(transactionId(codec.encode(tx.tx))).toBe(MOCK_PAYMENT);
      // ... which do not know the transaction types of Xahau.
      expect(() => codec.encode(fixtureTransaction('xahau-recorded', XAHAU_CLAIM_REWARD).tx.tx)).toThrow();
    });

    it.each([
      ['nothing', undefined],
      ['an empty result', {}],
      ['a result without the enums', { hash: 'ABC' }],
      ['a result the codec cannot build definitions from', { ...XAHAU_SERVER_DEFINITIONS, TYPES: 'nope' }],
    ])('falls back when the node answers %s', async (_name, answer) => {
      const { codec } = await started(
        'xahau',
        nodeWith(() => answer),
      );
      expect(codec.definitionsSource).toBe('profile');
    });

    it('does not fail the boot when the fallback itself is unusable: the built-in definitions apply', async () => {
      const profile = { ...getNetworkProfile('xahau'), definitionsFallback: () => ({ TYPES: 'nope' }) };
      const codec = new BinaryCodecService(nodeDown().xrpl, profile);
      await expect(codec.onModuleInit()).resolves.toBeUndefined();
      expect(codec.definitionsSource).toBe('builtin');
    });

    it('works before onModuleInit with the built-in definitions', () => {
      const codec = new BinaryCodecService(nodeDown().xrpl, getNetworkProfile('xrpl'));
      const { tx } = fixtureTransaction('ripple-mock', MOCK_PAYMENT);
      expect(transactionId(codec.encode(tx.tx))).toBe(MOCK_PAYMENT);
      expect(codec.definitionsSource).toBe('builtin');
    });

    it('lists the transaction types and results the definitions know', async () => {
      const xahau = await started('xahau', nodeDown());
      expect(xahau.codec.transactionTypes()).toEqual(expect.arrayContaining(['Payment', 'OfferCreate', 'ClaimReward']));
      expect(xahau.codec.transactionTypes()).not.toContain('Invalid');
      expect(xahau.codec.transactionResults()).toEqual(expect.arrayContaining(['tesSUCCESS', 'tecPATH_DRY']));

      const xrpl = await started('xrpl', nodeDown());
      expect(xrpl.codec.transactionTypes()).toEqual(expect.arrayContaining(['Payment', 'AMMCreate']));
      expect(xrpl.codec.transactionTypes()).not.toContain('ClaimReward');
      expect(xrpl.codec.transactionResults()).toEqual(expect.arrayContaining(['tesSUCCESS', 'tecUNFUNDED_PAYMENT']));
      // Names only: the lookup also holds the ordinals.
      expect(xrpl.codec.transactionResults().every((name) => /^[a-zA-Z]+/.test(name))).toBe(true);
      expect(new Set(xrpl.codec.transactionResults()).size).toBe(xrpl.codec.transactionResults().length);
    });
  });

  describe('encode / decode', () => {
    it('round trips a mainnet Payment: decode(encode(tx_json)) is tx_json and the blob hashes to the stored hash', async () => {
      const { codec } = await started('xrpl', nodeDown());
      const { tx, row } = fixtureTransaction('ripple-mock', MOCK_PAYMENT);
      const hex = codec.encode(tx.tx);
      expect(hex).toMatch(/^[0-9A-F]+$/);
      expect(codec.decode(hex)).toEqual(tx.tx);
      expect(decode(hex)).toEqual(tx.tx); // the codec's own default definitions agree
      expect(transactionId(hex)).toBe(row.hash);
    });

    it('round trips a recorded Xahau ClaimReward with the bundled Xahau definitions', async () => {
      const { codec } = await started('xahau', nodeDown());
      const { tx, row } = fixtureTransaction('xahau-recorded', XAHAU_CLAIM_REWARD);
      const hex = codec.encode(tx.tx);
      expect(codec.decode(hex)).toEqual(tx.tx);
      expect(transactionId(hex)).toBe(row.hash);
    });

    it('encodes the stored JSON of every fixture transaction to the blob that was signed (hash check)', async () => {
      const mock = await started('xrpl', nodeDown());
      for (const { row } of fixtureTransactions('ripple-mock')) {
        expect(transactionId(mock.codec.encode(JSON.parse(row.tx_json)))).toBe(row.hash);
      }
      const xahau = await started('xahau', nodeDown());
      for (const { row } of fixtureTransactions('xahau-recorded')) {
        expect(transactionId(xahau.codec.encode(JSON.parse(row.tx_json)))).toBe(row.hash);
      }
    });

    it('encodes metadata with the same definitions (hex, upper case)', async () => {
      const { codec } = await started('xahau', nodeDown());
      const { tx } = fixtureTransaction('xahau-recorded', XAHAU_CLAIM_REWARD);
      const hex = codec.encode(tx.meta);
      expect(hex).toMatch(/^[0-9A-F]+$/);
      expect(codec.decode(hex)).toMatchObject({
        TransactionResult: 'tesSUCCESS',
        TransactionIndex: tx.meta.TransactionIndex,
      });
    });
  });

  describe('when the node was not reachable at boot', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('keeps asking for the definitions and switches to them once the node answers; stops with the module', async () => {
      let up = false;
      const node = nodeWith(() => {
        if (!up) throw new Error('No node connection');
        return XAHAU_SERVER_DEFINITIONS;
      });
      const { codec } = await started('xrpl', node);
      expect(codec.definitionsSource).toBe('builtin');
      expect(node.request).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS);
      expect(node.request).toHaveBeenCalledTimes(2);
      expect(codec.definitionsSource).toBe('builtin');

      up = true;
      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS);
      expect(node.request).toHaveBeenCalledTimes(3);
      expect(codec.definitionsSource).toBe('node');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('server_definitions of the node'));

      // Settled: no further requests, no pending timer.
      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS * 3);
      expect(node.request).toHaveBeenCalledTimes(3);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('onModuleDestroy cancels the retry', async () => {
      const node = nodeDown();
      const { codec } = await started('xrpl', node);
      expect(jest.getTimerCount()).toBe(1);
      codec.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS * 2);
      expect(node.request).toHaveBeenCalledTimes(1);
    });

    it('does not retry again when the module was destroyed while a retry was in flight', async () => {
      let fail!: (err: Error) => void;
      let calls = 0;
      const node = nodeWith(() => {
        calls += 1;
        if (calls === 1) throw new Error('No node connection');
        return new Promise((_, reject) => (fail = reject));
      });
      const { codec } = await started('xrpl', node);
      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS); // the retry is now waiting for the node
      expect(node.request).toHaveBeenCalledTimes(2);
      codec.onModuleDestroy();
      fail(new Error('No node connection'));
      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS * 2);
      expect(node.request).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not retry when the node answered', async () => {
      const { codec, request } = await started(
        'xrpl',
        nodeWith(() => XAHAU_SERVER_DEFINITIONS),
      );
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS * 2);
      expect(request).toHaveBeenCalledTimes(1);
      codec.onModuleDestroy();
    });
  });
});
