import { getNetworkProfile, NetworkName } from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from 'ripple-binary-codec';
import {
  fixtureTransaction,
  fixtureTransactions,
  transactionId,
  transactionTreeRoot,
  XAHAU_FLAG_LEDGER,
  XAHAU_RECORDED_DIR,
  xahauFlagNodeBlobs,
  XRPL_RECORDED_DIR,
} from '../../test/support/fixtures';
import type { XrplService } from '../xrpl/xrpl.service';
import { BinaryCodecService, DEFINITIONS_RETRY_MS } from './binary-codec.service';

/** What a Xahau node answers to `server_definitions` (recorded from xahau.network). */
const XAHAU_SERVER_DEFINITIONS = JSON.parse(
  readFileSync(join(XAHAU_RECORDED_DIR, 'server_definitions.json'), 'utf8'),
) as Record<string, unknown>;

/** What an XRPL node answers to `server_definitions` (recorded from s2.ripple.com; also bundled as the xrpl fallback). */
const XRPL_SERVER_DEFINITIONS = JSON.parse(
  readFileSync(join(XRPL_RECORDED_DIR, 'server_definitions.json'), 'utf8'),
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

/** A copy of the transaction with another `Account`. */
const withAccount = (tx: Record<string, unknown>, account: string) => ({ ...tx, Account: account });

/** A network profile that bundles no definitions at all. */
const withoutBundledDefinitions = (network: NetworkName) => ({
  ...getNetworkProfile(network),
  definitionsFallback: () => undefined,
});

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
      // Neither the bundled XRPL definitions nor the built-in ones know ClaimReward: only the node's answer encodes it.
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

    it("falls back to the XRPL profile's bundled definitions too, which know the newest transaction types", async () => {
      const { codec } = await started('xrpl', nodeDown());
      expect(codec.definitionsSource).toBe('profile');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('bundled xrpl definitions'));
      for (const type of ['OracleSet', 'Batch']) {
        const { tx, row } = fixtureTransactions('xrpl-recorded').find((t) => t.row.tx_type === type)!;
        expect(transactionId(codec.encode(JSON.parse(row.tx_json)))).toBe(tx.hash);
      }
    });

    it("falls back to the codec's built-in definitions when the node cannot answer and the profile has none", async () => {
      const codec = new BinaryCodecService(nodeDown().xrpl, withoutBundledDefinitions('xrpl'));
      await codec.onModuleInit();
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

    it.each([
      ['definitions the codec cannot build', () => ({ TYPES: 'nope' })],
      ['a corrupt bundled file', () => JSON.parse('{"TYPES": {')],
      ['a bundled file that is missing', () => undefined],
    ])(
      'does not fail the boot when the profile fallback is %s: the built-in definitions apply',
      async (_name, fallback) => {
        const profile = { ...getNetworkProfile('xahau'), definitionsFallback: fallback as () => never };
        const codec = new BinaryCodecService(nodeDown().xrpl, profile);
        await expect(codec.onModuleInit()).resolves.toBeUndefined();
        expect(codec.definitionsSource).toBe('builtin');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('built-in definitions'));
      },
    );

    it('says why a bundled file could not be read', async () => {
      const profile = {
        ...getNetworkProfile('xahau'),
        definitionsFallback: () => JSON.parse('{"TYPES": {'),
      };
      await new BinaryCodecService(nodeDown().xrpl, profile).onModuleInit();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/bundled xahau definitions.*(JSON|Unexpected|position)/i),
      );
    });

    it('works before onModuleInit with the built-in definitions of the codec', () => {
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
      expect(xrpl.codec.transactionTypes()).toEqual(
        expect.arrayContaining(['Payment', 'AMMCreate', 'OracleSet', 'Batch', 'MPTokenAuthorize', 'VaultCreate']),
      );
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
      for (const [seed, network] of [
        ['ripple-mock', 'xrpl'],
        ['xrpl-recorded', 'xrpl'],
        ['xahau-recorded', 'xahau'],
      ] as const) {
        const { codec } = await started(network, nodeDown());
        const rows = fixtureTransactions(seed);
        expect(rows.length).toBeGreaterThan(0);
        for (const { row } of rows) {
          expect(transactionId(codec.encode(JSON.parse(row.tx_json)))).toBe(row.hash);
        }
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

  describe('an empty AccountID (Xahau UNLReport, Account ""; ruling R97)', () => {
    const ZERO = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp';
    const flag = () => fixtureTransactions('xahau-flag');
    const reports = () => flag().filter((t) => t.row.tx_type === 'UNLReport');

    it('serializes Account "" as a zero-length field (81 00): every blob of the flag ledger is the node\'s own', async () => {
      const { codec } = await started('xahau', nodeDown());
      const node = xahauFlagNodeBlobs();
      expect(reports()).toHaveLength(22);
      for (const { row } of flag()) {
        const tx = codec.encode(JSON.parse(row.tx_json));
        expect(tx).toBe(node.get(row.hash)?.tx);
        expect(transactionId(tx)).toBe(row.hash);
        expect(codec.encode(JSON.parse(row.meta_json))).toBe(node.get(row.hash)?.meta);
      }
      expect(codec.encode(JSON.parse(reports()[0].row.tx_json))).toContain('73008100');
    });

    it('re-hashes the transaction tree of the flag ledger to its transaction_hash', async () => {
      const { codec } = await started('xahau', nodeDown());
      const items = flag().map(({ row }) => ({
        hash: row.hash,
        tx: codec.encode(JSON.parse(row.tx_json)),
        meta: codec.encode(JSON.parse(row.meta_json)),
      }));
      const { ledger } = flag()[0];
      expect(ledger.header.ledger_index).toBe(XAHAU_FLAG_LEDGER);
      expect(transactionTreeRoot(items)).toBe(ledger.header.transaction_hash);
    });

    it('round trips Account "" as "" (not the zero account): roundTrip is decode(encode()) that keeps it', async () => {
      const { codec } = await started('xahau', nodeDown());
      for (const { tx } of reports()) {
        const json = codec.roundTrip(tx.tx);
        expect(json.Account).toBe('');
        // The canonical JSON of the same transaction with the zero account, but with the node's "" in it.
        expect(json).toEqual({ ...codec.decode(codec.encode(withAccount(tx.tx, ZERO))), Account: '' });
        expect(transactionId(codec.encode(json))).toBe(tx.hash);
      }
    });

    it('is decode(encode()) for every other transaction', async () => {
      const { codec } = await started('xahau', nodeDown());
      for (const { row } of [...fixtureTransactions('xahau-recorded'), ...flag()].filter(
        (t) => t.row.tx_type !== 'UNLReport',
      )) {
        const stored = JSON.parse(row.tx_json);
        expect(codec.roundTrip(stored)).toEqual(codec.decode(codec.encode(stored)));
      }
    });

    it('keeps an explicit zero account (XRPL pseudo-transactions) as 20 zero bytes', async () => {
      const { codec } = await started('xrpl', nodeDown());
      const pseudo = {
        TransactionType: 'EnableAmendment',
        Account: ZERO,
        Fee: '0',
        Sequence: 0,
        SigningPubKey: '',
        Amendment: 'AB'.repeat(32),
        LedgerSequence: 1,
      };
      expect(codec.encode(pseudo)).toContain(`8114${'00'.repeat(20)}`);
      expect(codec.roundTrip(pseudo).Account).toBe(ZERO);
    });

    it('serializes every empty AccountID field, nested ones too, as zero length, and gives each back as ""', async () => {
      const { codec } = await started('xahau', nodeDown());
      const meta = {
        TransactionIndex: 3,
        TransactionResult: 'tesSUCCESS',
        AffectedNodes: [
          {
            ModifiedNode: {
              LedgerEntryType: 'AccountRoot',
              LedgerIndex: 'CD'.repeat(32),
              FinalFields: { Account: '', Balance: '10', Flags: 0, OwnerCount: 0, Sequence: 1 },
              PreviousFields: { Balance: '20' },
            },
          },
        ],
      };
      const hex = codec.encode(meta);
      // The Account of FinalFields (field 1 of type 8): its header and a zero length, nothing after it.
      expect(hex).toContain('8100');
      expect(hex).not.toContain('8114');
      expect(codec.roundTrip(meta)).toEqual(meta);

      const payment = {
        TransactionType: 'Payment',
        Account: '',
        Destination: '',
        Amount: '1',
        Fee: '0',
        Sequence: 0,
        SigningPubKey: '',
      };
      const blob = codec.encode(payment);
      expect(blob).toContain('81008300');
      expect(codec.roundTrip(payment)).toMatchObject({ Account: '', Destination: '' });
    });

    it('does not change the object it is given', async () => {
      const { codec } = await started('xahau', nodeDown());
      const tx = structuredClone(reports()[0].tx.tx);
      const before = JSON.stringify(tx);
      codec.encode(tx);
      codec.roundTrip(tx);
      expect(JSON.stringify(tx)).toBe(before);
    });
  });

  describe('transactions the 1.x codec could not serialize (ripple-binary-codec 2.x)', () => {
    const ACCOUNT = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg';
    const DESTINATION = 'rP2GYatF5ZNCnu4zvf2SSB3yEopBdyzirW';
    const MPT_ID = '000000010E0AC5AB06C8A19E7FC1D0E7E7B0C0E5F1B7C6A4';
    const common = { Account: ACCOUNT, Fee: '10', Sequence: 7, Flags: 0, SigningPubKey: '' };

    const synthetic = {
      'an MPTokenAuthorize (Hash192 MPTokenIssuanceID)': {
        TransactionType: 'MPTokenAuthorize',
        ...common,
        MPTokenIssuanceID: MPT_ID,
      },
      'a Payment of an MPT amount': {
        TransactionType: 'Payment',
        ...common,
        Destination: DESTINATION,
        Amount: { mpt_issuance_id: MPT_ID, value: '100' },
      },
      'a VaultCreate (Number AssetsMaximum)': {
        TransactionType: 'VaultCreate',
        ...common,
        Asset: { currency: 'USD', issuer: DESTINATION },
        AssetsMaximum: '1000.5',
      },
      'a transaction with an Int32 field (LoanScale)': { TransactionType: 'LoanSet', ...common, LoanScale: -5 },
    };

    const sources: [string, () => Promise<BinaryCodecService>][] = [
      [
        'the XRPL definitions of the node',
        async () =>
          (
            await started(
              'xrpl',
              nodeWith(() => XRPL_SERVER_DEFINITIONS),
            )
          ).codec,
      ],
      ['the bundled XRPL definitions', async () => (await started('xrpl', nodeDown())).codec],
      [
        "the codec's built-in definitions",
        async () => {
          const codec = new BinaryCodecService(nodeDown().xrpl, withoutBundledDefinitions('xrpl'));
          await codec.onModuleInit();
          return codec;
        },
      ],
    ];

    describe.each(sources)('with %s', (_name, build) => {
      it.each(Object.entries(synthetic))('encodes %s and decodes it back', async (_what, tx) => {
        const codec = await build();
        const hex = codec.encode(tx);
        expect(hex).toMatch(/^[0-9A-F]+$/);
        expect(codec.decode(hex)).toEqual(tx);
      });
    });

    it('keeps the MPT amount exactly as the node writes it', async () => {
      const { codec } = await started('xrpl', nodeDown());
      const payment = synthetic['a Payment of an MPT amount'];
      expect((codec.decode(codec.encode(payment)).Amount as Record<string, unknown>).mpt_issuance_id).toBe(MPT_ID);
    });
  });

  describe('DeliverMax', () => {
    // rippled and xahaud add DeliverMax, a JSON alias of Amount, to the Payments they serve; it is not serialized.
    const payment = {
      TransactionType: 'Payment',
      Account: 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg',
      Destination: 'rP2GYatF5ZNCnu4zvf2SSB3yEopBdyzirW',
      Fee: '10',
      Sequence: 7,
      Flags: 0,
      SigningPubKey: '',
    };

    it('is left out of the serialization: the blob is the one of the transaction without it', async () => {
      const { codec } = await started('xrpl', nodeDown());
      const plain = codec.encode({ ...payment, Amount: '1000' });
      expect(codec.encode({ ...payment, Amount: '1000', DeliverMax: '1000' })).toBe(plain);
    });

    it('stands in for a missing Amount', async () => {
      const { codec } = await started('xrpl', nodeDown());
      expect(codec.encode({ ...payment, DeliverMax: '1000' })).toBe(codec.encode({ ...payment, Amount: '1000' }));
    });

    it('does not change the object it is given', async () => {
      const { codec } = await started('xrpl', nodeDown());
      const input = Object.freeze({ ...payment, Amount: '1000', DeliverMax: '1000' });
      expect(() => codec.encode(input)).not.toThrow();
      expect(input.DeliverMax).toBe('1000');
    });

    it('is the only JSON-only field that is tolerated: lower case ones are skipped, an unknown field fails', async () => {
      const { codec } = await started('xrpl', nodeDown());
      const plain = codec.encode({ ...payment, Amount: '1000' });
      expect(
        codec.encode({ ...payment, Amount: '1000', hash: 'AB', date: 5, ctid: 'C', delivered_amount: '1000' }),
      ).toBe(plain);
      expect(() => codec.encode({ ...payment, Amount: '1000', Bogus: 1 })).toThrow(/Bogus/);
    });

    it('is no problem for the recorded Payments that carry it', async () => {
      const { codec } = await started('xahau', nodeDown());
      const withDeliverMax = fixtureTransactions('xahau-recorded').filter(
        (t) => 'DeliverMax' in JSON.parse(t.row.tx_json),
      );
      expect(withDeliverMax.length).toBeGreaterThan(10);
      for (const { row } of withDeliverMax) expect(transactionId(codec.encode(JSON.parse(row.tx_json)))).toBe(row.hash);
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
      expect(codec.definitionsSource).toBe('profile');
      expect(node.request).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS);
      expect(node.request).toHaveBeenCalledTimes(2);
      expect(codec.definitionsSource).toBe('profile');

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

    it('counts a generation of definitions: it changes each time other definitions are put to use', async () => {
      let up = false;
      const node = nodeWith(() => {
        if (!up) throw new Error('No node connection');
        return XAHAU_SERVER_DEFINITIONS;
      });
      const codec = new BinaryCodecService(node.xrpl, getNetworkProfile('xrpl'));
      const initial = codec.generation;
      await codec.onModuleInit(); // the bundled XRPL definitions
      const bundled = codec.generation;
      expect(bundled).not.toBe(initial);
      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS); // still no node
      expect(codec.generation).toBe(bundled);
      up = true;
      await jest.advanceTimersByTimeAsync(DEFINITIONS_RETRY_MS);
      expect(codec.definitionsSource).toBe('node');
      expect(codec.generation).not.toBe(bundled);
      codec.onModuleDestroy();
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
