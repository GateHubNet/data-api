import { ClickHouseService, getNetworkProfile, NetworkName, TransactionsRow } from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XrplDefinitions } from 'ripple-binary-codec';
import {
  fixtureTransaction,
  fixtureTransactions,
  SeedName,
  transactionId,
  XRPL_RECORDED_DIR,
} from '../../test/support/fixtures';
import { ApiConfig } from '../config/api.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import type { XrplService } from '../xrpl/xrpl.service';
import { BinaryCodecService } from './binary-codec.service';
import { TxService } from './tx-object';

const MOCK_PAYMENT = '22F26CE4E2270CE3CF4EB61C609E7ADEDCD41D4C1BA2D96D680A9B016C4F47DA';
const XAHAU_CLAIM_REWARD = '3A1F25CDF0E2E4466AA0B019EA3039A6E5F87C01FBDD69CBDC474DAC32D8E64C';

// The codec warns when it falls back, and TxService when a transaction cannot be serialized; the tests that expect
// either assert it. The rest of the output stays clean.
let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const noNode = { request: jest.fn().mockRejectedValue(new Error('No node connection')) } as unknown as XrplService;

interface Services {
  service: TxService;
  codec: BinaryCodecService;
  prometheus: PrometheusService;
}

/**
 * A TxService on a codec that has the definitions of `network`. `txCacheSize` is `GH_TX_CACHE_SIZE`: 0 (off) unless a
 * test is about the cache, because most tests change a row and keep its hash, which the cache would answer from.
 */
async function serviceFor(network: NetworkName, node: XrplService = noNode, txCacheSize = 0): Promise<Services> {
  const profile = getNetworkProfile(network);
  const codec = new BinaryCodecService(node, profile);
  await codec.onModuleInit();
  codec.onModuleDestroy(); // no retry timer in a unit test
  const prometheus = new PrometheusService();
  warn.mockClear(); // the codec's own warning about its fallback definitions is not what the tests look at
  const config = Object.assign(new ApiConfig(), { txCacheSize });
  return { service: new TxService({} as ClickHouseService, codec, profile, prometheus, config), codec, prometheus };
}

/** How often a transaction was served as stored JSON because it could not be serialized, per mode, so far. */
async function fallbackTotals(prometheus: PrometheusService): Promise<{ json: number; binary: number }> {
  const { values } = await prometheus.txEncodeFallback.get();
  const total = (mode: string) => values.find((v) => v.labels.mode === mode)?.value ?? 0;
  return { json: total('json'), binary: total('binary') };
}

/**
 * Counts the fallbacks of `action`. The counter lives in the process-wide registry (as in production, where the
 * scrape endpoint reads the same one), so a test looks at what changed, not at the total.
 */
async function fallbacksDuring(
  prometheus: PrometheusService,
  action: () => void | Promise<void>,
): Promise<{ json: number; binary: number }> {
  const before = await fallbackTotals(prometheus);
  await action();
  const after = await fallbackTotals(prometheus);
  return { json: after.json - before.json, binary: after.binary - before.binary };
}

/** The row the syncer stores for a fixture transaction, with `change` applied to the transaction and metadata JSON. */
function rowOf(
  seed: SeedName,
  hash: string,
  change: (tx: Record<string, any>, meta: Record<string, any>) => void = () => undefined,
): TransactionsRow {
  const { row } = fixtureTransaction(seed, hash);
  const tx = JSON.parse(row.tx_json);
  const meta = JSON.parse(row.meta_json);
  change(tx, meta);
  return { ...row, tx_json: JSON.stringify(tx), meta_json: JSON.stringify(meta) };
}

/** A row for a transaction that is not in the fixtures. */
function rowFrom(
  tx: Record<string, unknown>,
  meta: Record<string, unknown>,
  ledgerIndex = 107_000_000,
): TransactionsRow {
  return {
    ledger_index: ledgerIndex,
    tx_index: 0,
    hash: 'AB'.repeat(32),
    tx_type: String(tx.TransactionType),
    result: String(meta.TransactionResult),
    account: String(tx.Account),
    sequence: Number(tx.Sequence),
    fee: String(tx.Fee),
    close_time: 1_700_000_000,
    tx_json: JSON.stringify(tx),
    meta_json: JSON.stringify(meta),
  };
}

const TF_PARTIAL_PAYMENT = 0x00020000;
const GBP = { currency: 'GBP', issuer: 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q', value: '12.5' };
const ACCOUNT = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg';
const DESTINATION = 'rP2GYatF5ZNCnu4zvf2SSB3yEopBdyzirW';
const MPT_ID = '000000010E0AC5AB06C8A19E7FC1D0E7E7B0C0E5F1B7C6A4';
const META_OK = { AffectedNodes: [], TransactionIndex: 0, TransactionResult: 'tesSUCCESS' };

describe('TxService.toTxObject', () => {
  describe('JSON mode', () => {
    it('serves the transaction and metadata with the ledger fields of the Ripple API, in its field order', async () => {
      const { service, codec } = await serviceFor('xrpl');
      const fixture = fixtureTransaction('ripple-mock', MOCK_PAYMENT);
      const obj = service.toTxObject(fixture.row, { binary: false });
      expect(Object.keys(obj)).toEqual(['hash', 'ledger_index', 'date', 'tx', 'meta']);
      expect(obj.hash).toBe(MOCK_PAYMENT);
      expect(obj.ledger_index).toBe(11119603);
      expect(obj.date).toBe('2015-01-14T18:27:20+00:00');
      // already canonical in the fixture, so the same as stored
      expect(obj.tx).toEqual(fixture.tx.tx);
      expect(obj.meta).toEqual({ ...fixture.tx.meta, delivered_amount: '300000000' });
      // and exactly what the Ripple API served: the decoded binary
      expect(obj.tx).toEqual(codec.decode(codec.encode(fixture.tx.tx)));
    });

    it('puts ledger_hash after date when given, and leaves the key out otherwise', async () => {
      const { service } = await serviceFor('xrpl');
      const { row } = fixtureTransaction('ripple-mock', MOCK_PAYMENT);
      const withHash = service.toTxObject(row, { binary: false, ledgerHash: 'AB'.repeat(32) });
      expect(Object.keys(withHash)).toEqual(['hash', 'ledger_index', 'date', 'ledger_hash', 'tx', 'meta']);
      expect(withHash.ledger_hash).toBe('AB'.repeat(32));
      expect(Object.keys(service.toTxObject(row, { binary: false, ledgerHash: undefined }))).not.toContain(
        'ledger_hash',
      );
    });

    it('injects meta.delivered_amount for a successful Payment (the Ripple test: 300000000)', async () => {
      const { service } = await serviceFor('xrpl');
      const obj = service.toTxObject(rowOf('ripple-mock', MOCK_PAYMENT), { binary: false });
      expect((obj.meta as Record<string, unknown>).delivered_amount).toBe('300000000');
    });

    it('omits delivered_amount for an OfferCreate and for every other transaction type', async () => {
      const { service } = await serviceFor('xrpl');
      const others = fixtureTransactions('ripple-mock').filter((t) => t.row.tx_type !== 'Payment');
      expect(others.some((t) => t.row.tx_type === 'OfferCreate')).toBe(true);
      for (const { row } of others) {
        const meta = service.toTxObject(row, { binary: false }).meta as Record<string, unknown>;
        expect(meta).not.toHaveProperty('delivered_amount');
      }
    });

    it('omits delivered_amount for a Payment that did not succeed', async () => {
      const { service } = await serviceFor('xrpl');
      const failed = fixtureTransactions('ripple-mock').filter(
        (t) => t.row.tx_type === 'Payment' && t.row.result !== 'tesSUCCESS',
      );
      const row =
        failed.length > 0
          ? failed[0].row
          : rowOf('ripple-mock', MOCK_PAYMENT, (_tx, meta) => (meta.TransactionResult = 'tecPATH_DRY'));
      const meta = service.toTxObject(row, { binary: false }).meta as Record<string, unknown>;
      expect(meta).not.toHaveProperty('delivered_amount');
    });

    it('uses DeliveredAmount over Amount, and the issued-currency amount is a copy', async () => {
      const { service } = await serviceFor('xrpl');
      const row = rowOf('ripple-mock', MOCK_PAYMENT, (tx, meta) => {
        tx.Amount = { ...GBP, value: '20' };
        meta.DeliveredAmount = GBP;
      });
      const obj = service.toTxObject(row, { binary: false });
      const meta = obj.meta as Record<string, any>;
      expect(meta.delivered_amount).toEqual(GBP);
      expect(meta.delivered_amount).not.toBe(meta.DeliveredAmount);
    });

    it('does not share the Amount object between tx and meta.delivered_amount', async () => {
      const { service } = await serviceFor('xrpl');
      const row = rowOf('ripple-mock', MOCK_PAYMENT, (tx) => {
        tx.Amount = GBP;
      });
      const obj = service.toTxObject(row, { binary: false });
      const meta = obj.meta as Record<string, any>;
      expect(meta.delivered_amount).toEqual(GBP);
      expect(meta.delivered_amount).not.toBe((obj.tx as Record<string, unknown>).Amount);
      (meta.delivered_amount as Record<string, unknown>).value = 'changed';
      expect((obj.tx as Record<string, any>).Amount.value).toBe('12.5');
    });

    it("takes a partial payment's delivered amount from Amount after the 4594094 fix, and 'unavailable' before it", async () => {
      const { service } = await serviceFor('xrpl');
      const partial = rowOf('ripple-mock', MOCK_PAYMENT, (tx) => {
        tx.Flags = TF_PARTIAL_PAYMENT;
      });
      const before = service.toTxObject({ ...partial, ledger_index: 4594094 }, { binary: false });
      expect((before.meta as Record<string, unknown>).delivered_amount).toBe('unavailable');
      const after = service.toTxObject({ ...partial, ledger_index: 4594095 }, { binary: false });
      expect((after.meta as Record<string, unknown>).delivered_amount).toBe('300000000');
    });

    it('applies the network context: on Xahau a partial payment is delivered from the first ledger', async () => {
      const { service } = await serviceFor('xahau');
      const { row } = fixtureTransaction('xahau-recorded', XAHAU_CLAIM_REWARD);
      // Only Payments get the field.
      expect(service.toTxObject(row, { binary: false }).meta as Record<string, unknown>).not.toHaveProperty(
        'delivered_amount',
      );
      const payment = fixtureTransactions('xahau-recorded').find(
        (t) => t.row.tx_type === 'Payment' && t.row.result === 'tesSUCCESS',
      );
      expect(payment).toBeDefined();
      const partial = JSON.parse(payment!.row.tx_json);
      partial.Flags = TF_PARTIAL_PAYMENT;
      const meta = JSON.parse(payment!.row.meta_json);
      delete meta.DeliveredAmount;
      delete meta.delivered_amount;
      const obj = service.toTxObject(
        { ...payment!.row, ledger_index: 1, tx_json: JSON.stringify(partial), meta_json: JSON.stringify(meta) },
        { binary: false },
      );
      expect((obj.meta as Record<string, unknown>).delivered_amount).toEqual(partial.Amount);
    });

    it('builds fresh objects on every call and never changes the row', async () => {
      const { service } = await serviceFor('xrpl');
      const row = Object.freeze({ ...fixtureTransaction('ripple-mock', MOCK_PAYMENT).row });
      const first = service.toTxObject(row, { binary: false });
      (first.tx as Record<string, unknown>).Fee = 'changed';
      (first.meta as Record<string, unknown>).delivered_amount = 'changed';
      const second = service.toTxObject(row, { binary: false });
      expect((second.tx as Record<string, unknown>).Fee).toBe('15000');
      expect((second.meta as Record<string, unknown>).delivered_amount).toBe('300000000');
      expect(row).toEqual(fixtureTransaction('ripple-mock', MOCK_PAYMENT).row);
    });
  });

  describe('JSON mode serves what the Ripple API served: the decoded binary (ruling R38)', () => {
    const xahauPayment = () =>
      fixtureTransactions('xahau-recorded').find(
        (t) =>
          t.row.tx_type === 'Payment' && t.row.result === 'tesSUCCESS' && 'DeliverMax' in JSON.parse(t.row.tx_json),
      )!;

    it('is decode(encode(stored)) with the definitions of the network, before delivered_amount goes in', async () => {
      const { service, codec } = await serviceFor('xahau');
      for (const { row } of fixtureTransactions('xahau-recorded').slice(0, 60)) {
        const obj = service.toTxObject(row, { binary: false });
        const { DeliverMax, ...stored } = JSON.parse(row.tx_json);
        expect(DeliverMax === undefined || stored.Amount !== undefined).toBe(true);
        expect(obj.tx).toEqual(codec.decode(codec.encode(stored)));
        const { delivered_amount, ...meta } = obj.meta as Record<string, unknown>;
        expect(meta).toEqual(codec.decode(codec.encode(JSON.parse(row.meta_json))));
        expect(delivered_amount === undefined || row.tx_type === 'Payment').toBe(true);
      }
    });

    it('has no DeliverMax, which rippled and xahaud add to the Payments they serve', async () => {
      const { service } = await serviceFor('xahau');
      const { row } = xahauPayment();
      expect(JSON.parse(row.tx_json)).toHaveProperty('DeliverMax');
      const tx = service.toTxObject(row, { binary: false }).tx as Record<string, unknown>;
      expect(tx).not.toHaveProperty('DeliverMax');
      expect(tx).toHaveProperty('Amount');
    });

    it('has no type and type_hex in the steps of Paths', async () => {
      const { service } = await serviceFor('xrpl');
      const withPaths = fixtureTransactions('ripple-mock').find((t) => t.row.tx_type === 'Payment' && t.tx.tx.Paths)!;
      const stored = JSON.parse(withPaths.row.tx_json);
      expect(stored.Paths.flat().some((step: Record<string, unknown>) => 'type' in step && 'type_hex' in step)).toBe(
        true,
      );
      const paths = (service.toTxObject(withPaths.row, { binary: false }).tx as Record<string, any>).Paths;
      expect(paths).toHaveLength(stored.Paths.length);
      for (const step of paths.flat()) {
        expect(step).not.toHaveProperty('type');
        expect(step).not.toHaveProperty('type_hex');
      }
      expect(paths.flat().map((s: Record<string, unknown>) => s.account ?? s.currency)).toEqual(
        stored.Paths.flat().map((s: Record<string, unknown>) => s.account ?? s.currency),
      );
    });

    it('writes UInt64 fields of the metadata as 16 upper case hex digits', async () => {
      const { service } = await serviceFor('xahau');
      const { row } = xahauPayment();
      expect(row.meta_json).toMatch(/"OwnerNode":"[0-9a-f]{1,15}"/); // rippled: short and lower case
      const meta = JSON.stringify(service.toTxObject(row, { binary: false }).meta);
      expect(meta).toMatch(/"OwnerNode":"[0-9A-F]{16}"/);
      expect(meta).not.toMatch(/"OwnerNode":"[0-9a-f]{1,15}"/);
    });

    it('lists the fields in the order of the binary format, as the decoded binary does', async () => {
      const { service, codec } = await serviceFor('xahau');
      const { row } = xahauPayment();
      const stored = Object.keys(JSON.parse(row.tx_json));
      expect(stored[0]).toBe('Account'); // rippled lists them alphabetically
      const tx = service.toTxObject(row, { binary: false }).tx as Record<string, unknown>;
      expect(Object.keys(tx)[0]).toBe('TransactionType');
      expect(Object.keys(tx)).toEqual(Object.keys(codec.decode(codec.encode(JSON.parse(row.tx_json)))));
    });

    it("drops rippled's own meta.delivered_amount and works the value out again from the transaction", async () => {
      const { service } = await serviceFor('xahau');
      const { row } = xahauPayment();
      const stored = JSON.parse(row.meta_json);
      expect(stored).toHaveProperty('delivered_amount');
      const lying = { ...row, meta_json: JSON.stringify({ ...stored, delivered_amount: '999' }) };
      const obj = service.toTxObject(lying, { binary: false });
      expect((obj.meta as Record<string, unknown>).delivered_amount).toEqual(JSON.parse(row.tx_json).Amount);

      const failed = { ...row, meta_json: JSON.stringify({ ...stored, TransactionResult: 'tecPATH_DRY' }) };
      expect(service.toTxObject(failed, { binary: false }).meta as Record<string, unknown>).not.toHaveProperty(
        'delivered_amount',
      );
      expect(Object.keys(service.toTxObject(row, { binary: false }).meta as object)).not.toContain('DeliverMax');
    });

    it('keeps DeliveredAmount, which is part of the binary metadata', async () => {
      const { service } = await serviceFor('xrpl');
      const row = rowOf('ripple-mock', MOCK_PAYMENT, (_tx, meta) => {
        meta.DeliveredAmount = '123';
      });
      const meta = service.toTxObject(row, { binary: false }).meta as Record<string, unknown>;
      expect(meta.DeliveredAmount).toBe('123');
      expect(meta.delivered_amount).toBe('123');
    });
  });

  describe('binary mode', () => {
    it('serves tx and meta as upper case hex, in the same field order', async () => {
      const { service, codec } = await serviceFor('xrpl');
      const fixture = fixtureTransaction('ripple-mock', MOCK_PAYMENT);
      const obj = service.toTxObject(fixture.row, { binary: true, ledgerHash: 'CD'.repeat(32) });
      expect(Object.keys(obj)).toEqual(['hash', 'ledger_index', 'date', 'ledger_hash', 'tx', 'meta']);
      expect(obj.hash).toBe(MOCK_PAYMENT);
      expect(typeof obj.tx).toBe('string');
      expect(typeof obj.meta).toBe('string');
      expect(obj.tx).toMatch(/^[0-9A-F]+$/);
      expect(obj.meta).toMatch(/^[0-9A-F]+$/);
      expect(obj.tx).toBe(codec.encode(fixture.tx.tx));
      expect(obj.meta).toBe(codec.encode(fixture.tx.meta));
      expect(transactionId(obj.tx as string)).toBe(MOCK_PAYMENT);
    });

    it('does not inject delivered_amount: the metadata is the serialized original', async () => {
      const { service, codec } = await serviceFor('xrpl');
      const { row } = fixtureTransaction('ripple-mock', MOCK_PAYMENT);
      const meta = codec.decode(service.toTxObject(row, { binary: true }).meta as string);
      expect(meta).not.toHaveProperty('delivered_amount');
      expect(meta.TransactionResult).toBe('tesSUCCESS');
      expect(meta.TransactionIndex).toBe(4);
    });

    it('uses the Xahau definitions on Xahau, and serializes a Payment that carries DeliverMax', async () => {
      const { service } = await serviceFor('xahau');
      const { row } = fixtureTransaction('xahau-recorded', XAHAU_CLAIM_REWARD);
      expect(transactionId(service.toTxObject(row, { binary: true }).tx as string)).toBe(XAHAU_CLAIM_REWARD);
      const payment = fixtureTransactions('xahau-recorded').find((t) => 'DeliverMax' in JSON.parse(t.row.tx_json))!;
      expect(transactionId(service.toTxObject(payment.row, { binary: true }).tx as string)).toBe(payment.row.hash);
    });
  });

  describe('transactions the XRPL tools of a few years ago could not serialize (ruling R39)', () => {
    it.each([
      [
        'an MPTokenAuthorize',
        {
          TransactionType: 'MPTokenAuthorize',
          Account: ACCOUNT,
          Fee: '10',
          Sequence: 7,
          Flags: 0,
          MPTokenIssuanceID: MPT_ID,
        },
        META_OK,
      ],
      [
        'a Payment of an MPT amount',
        {
          TransactionType: 'Payment',
          Account: ACCOUNT,
          Destination: DESTINATION,
          Amount: { mpt_issuance_id: MPT_ID, value: '100' },
          Fee: '10',
          Sequence: 7,
          Flags: 0,
        },
        META_OK,
      ],
      [
        'a VaultCreate',
        {
          TransactionType: 'VaultCreate',
          Account: ACCOUNT,
          Asset: { currency: 'USD', issuer: DESTINATION },
          AssetsMaximum: '1000.5',
          Fee: '10',
          Sequence: 7,
          Flags: 0,
        },
        META_OK,
      ],
    ])('serves %s in both modes without falling back', async (_name, tx, meta) => {
      const { service, codec, prometheus } = await serviceFor('xrpl');
      const row = rowFrom(tx, meta);
      const served = await fallbacksDuring(prometheus, () => {
        const json = service.toTxObject(row, { binary: false });
        expect(json.tx).toEqual(tx);
        const binary = service.toTxObject(row, { binary: true });
        expect(binary.tx).toMatch(/^[0-9A-F]+$/);
        expect(codec.decode(binary.tx as string)).toEqual(tx);
        expect(codec.decode(binary.meta as string)).toMatchObject({ TransactionResult: 'tesSUCCESS' });
      });
      expect(served).toEqual({ json: 0, binary: 0 });
      expect(warn).not.toHaveBeenCalled();
    });

    it('delivers an MPT amount as a copy', async () => {
      const { service } = await serviceFor('xrpl');
      const amount = { mpt_issuance_id: MPT_ID, value: '100' };
      const row = rowFrom(
        {
          TransactionType: 'Payment',
          Account: ACCOUNT,
          Destination: DESTINATION,
          Amount: amount,
          Fee: '10',
          Sequence: 7,
          Flags: 0,
        },
        META_OK,
      );
      const obj = service.toTxObject(row, { binary: false });
      const meta = obj.meta as Record<string, unknown>;
      expect(meta.delivered_amount).toEqual(amount);
      expect(meta.delivered_amount).not.toBe((obj.tx as Record<string, unknown>).Amount);
    });
  });

  describe('a transaction that cannot be serialized never fails the page (ruling R39)', () => {
    /** A Payment with a field the definitions do not have, and rippled's JSON-only DeliverMax next to Amount. */
    const stubborn = () =>
      rowOf('ripple-mock', MOCK_PAYMENT, (tx) => {
        tx.Mystery = 'AB';
        tx.DeliverMax = tx.Amount;
      });

    it('serves its stored JSON in JSON mode, without DeliverMax, and still injects delivered_amount', async () => {
      const { service, prometheus } = await serviceFor('xrpl');
      let obj!: ReturnType<TxService['toTxObject']>;
      const counted = await fallbacksDuring(prometheus, () => {
        obj = service.toTxObject(stubborn(), { binary: false, ledgerHash: 'EF'.repeat(32) });
      });
      expect(counted).toEqual({ json: 1, binary: 0 });
      const stored = JSON.parse(stubborn().tx_json);
      expect(Object.keys(obj)).toEqual(['hash', 'ledger_index', 'date', 'ledger_hash', 'tx', 'meta']);
      expect(obj.tx).toEqual({ ...stored, DeliverMax: undefined });
      expect(obj.tx).not.toHaveProperty('DeliverMax');
      expect(obj.tx).toHaveProperty('Mystery', 'AB');
      expect((obj.meta as Record<string, unknown>).delivered_amount).toBe('300000000');
    });

    it('serves it as JSON objects in binary mode too', async () => {
      const { service, prometheus } = await serviceFor('xrpl');
      let obj!: ReturnType<TxService['toTxObject']>;
      const counted = await fallbacksDuring(prometheus, () => {
        obj = service.toTxObject(stubborn(), { binary: true });
      });
      expect(typeof obj.tx).toBe('object');
      expect(typeof obj.meta).toBe('object');
      expect(obj.hash).toBe(MOCK_PAYMENT);
      expect(counted).toEqual({ json: 0, binary: 1 });
    });

    it('logs a warning that names the transaction and the reason', async () => {
      const { service } = await serviceFor('xrpl');
      service.toTxObject(stubborn(), { binary: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(MOCK_PAYMENT));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Mystery'));
    });

    it('keeps DeliverMax when there is no Amount to stand for it', async () => {
      const { service } = await serviceFor('xrpl');
      const row = rowOf('ripple-mock', MOCK_PAYMENT, (tx) => {
        tx.Mystery = 'AB';
        tx.DeliverMax = tx.Amount;
        delete tx.Amount;
      });
      expect(service.toTxObject(row, { binary: false }).tx).toHaveProperty('DeliverMax', '300000000');
    });

    it('is also the answer for metadata that cannot be serialized', async () => {
      const { service, prometheus } = await serviceFor('xrpl');
      const row = rowOf('ripple-mock', MOCK_PAYMENT, (_tx, meta) => {
        meta.Mystery = 'AB';
      });
      let obj!: ReturnType<TxService['toTxObject']>;
      const counted = await fallbacksDuring(prometheus, () => {
        obj = service.toTxObject(row, { binary: true });
      });
      expect(typeof obj.meta).toBe('object');
      expect(obj.meta).toHaveProperty('Mystery', 'AB');
      expect(counted).toEqual({ json: 0, binary: 1 });
    });

    it('serves a page of which one transaction is stubborn', async () => {
      const { service, prometheus } = await serviceFor('xrpl');
      const good = fixtureTransactions('ripple-mock')
        .slice(0, 5)
        .map((t) => t.row);
      const page = [good[0], good[1], stubborn(), good[2], good[3], good[4]];
      const counted = await fallbacksDuring(prometheus, () => {
        for (const binary of [false, true]) {
          const objects = page.map((row) => service.toTxObject(row, { binary }));
          expect(objects.map((o) => o.hash)).toEqual(page.map((r) => r.hash));
          expect(objects.map((o) => typeof o.tx)).toEqual(
            binary
              ? ['string', 'string', 'object', 'string', 'string', 'string']
              : ['object', 'object', 'object', 'object', 'object', 'object'],
          );
        }
      });
      expect(counted).toEqual({ json: 1, binary: 1 });
    });

    it('falls back for a field type that the definitions of the node do not know how to serialize', async () => {
      // A node whose definitions have a field of a type this codec has no class for.
      const definitions = JSON.parse(readFileSync(join(XRPL_RECORDED_DIR, 'server_definitions.json'), 'utf8'));
      definitions.TYPES.Hash777 = 777;
      definitions.FIELDS.push([
        'Zebra',
        { nth: 9, isVLEncoded: false, isSerialized: true, isSigningField: true, type: 'Hash777' },
      ]);
      expect(() => new XrplDefinitions(definitions)).not.toThrow();
      const node = { request: jest.fn().mockResolvedValue(definitions) } as unknown as XrplService;
      const { service, codec, prometheus } = await serviceFor('xrpl', node);
      expect(codec.definitionsSource).toBe('node');

      const zebra = rowOf('ripple-mock', MOCK_PAYMENT, (tx) => {
        tx.Zebra = 'AB';
      });
      expect(() => codec.encode(JSON.parse(zebra.tx_json))).toThrow();
      let obj!: ReturnType<TxService['toTxObject']>;
      expect(await fallbacksDuring(prometheus, () => void (obj = service.toTxObject(zebra, { binary: true })))).toEqual(
        {
          json: 0,
          binary: 1,
        },
      );
      expect(obj.tx).toHaveProperty('Zebra', 'AB');

      // a transaction without that field is still serialized
      let fine!: ReturnType<TxService['toTxObject']>;
      const row = fixtureTransaction('ripple-mock', MOCK_PAYMENT).row;
      expect(await fallbacksDuring(prometheus, () => void (fine = service.toTxObject(row, { binary: true })))).toEqual({
        json: 0,
        binary: 0,
      });
      expect(typeof fine.tx).toBe('string');
    });
  });

  describe('the cache of canonical forms (ruling R41)', () => {
    const row = () => fixtureTransaction('ripple-mock', MOCK_PAYMENT).row;
    const another = () => fixtureTransactions('ripple-mock')[3].row;
    const spies = (codec: BinaryCodecService) => ({
      encode: jest.spyOn(codec, 'encode'),
      decode: jest.spyOn(codec, 'decode'),
    });

    it.each([false, true])(
      'answers a second request for a transaction without the codec (binary: %s)',
      async (binary) => {
        const { service, codec } = await serviceFor('xrpl', noNode, 100);
        const first = service.toTxObject(row(), { binary, ledgerHash: 'AB'.repeat(32) });
        const { encode, decode } = spies(codec);
        const second = service.toTxObject(row(), { binary, ledgerHash: 'AB'.repeat(32) });
        expect(encode).not.toHaveBeenCalled();
        expect(decode).not.toHaveBeenCalled();
        expect(JSON.stringify(second)).toBe(JSON.stringify(first)); // same values, same field order
        expect(second).toEqual(first);
      },
    );

    it('serves the same output as without a cache', async () => {
      const cached = await serviceFor('xahau', noNode, 100);
      const plain = await serviceFor('xahau', noNode, 0);
      for (const { row } of fixtureTransactions('xahau-recorded').slice(0, 40)) {
        for (const binary of [false, true]) {
          cached.service.toTxObject(row, { binary }); // fills the cache
          const hit = cached.service.toTxObject(row, { binary });
          expect(JSON.stringify(hit)).toBe(JSON.stringify(plain.service.toTxObject(row, { binary })));
        }
      }
    });

    it('keeps JSON and binary apart: a JSON request does not answer a binary one', async () => {
      const { service } = await serviceFor('xrpl', noNode, 100);
      expect(typeof service.toTxObject(row(), { binary: false }).tx).toBe('object');
      expect(typeof service.toTxObject(row(), { binary: true }).tx).toBe('string');
      expect(typeof service.toTxObject(row(), { binary: false }).tx).toBe('object');
    });

    it('hands out copies: changing a returned object changes nothing the next request gets', async () => {
      const { service } = await serviceFor('xrpl', noNode, 100);
      const pristine = JSON.stringify(service.toTxObject(row(), { binary: false }));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // the first pass vandalizes the object of a cache miss, the second one that of a hit
        const obj = service.toTxObject(row(), { binary: false });
        const tx = obj.tx as Record<string, any>;
        const meta = obj.meta as Record<string, any>;
        tx.Fee = 'vandalized';
        tx.SigningPubKey = undefined;
        delete tx.Account;
        meta.AffectedNodes.length = 0;
        meta.AffectedNodes.push({ vandal: true });
        meta.TransactionResult = 'tecVANDAL';
        meta.delivered_amount = 'vandalized';
        (obj as unknown as Record<string, unknown>).hash = 'vandalized';
        expect(JSON.stringify(service.toTxObject(row(), { binary: false }))).toBe(pristine);
      }
    });

    it('injects delivered_amount onto a copy: the entry holds the canonical form without it', async () => {
      const { service } = await serviceFor('xrpl', noNode, 100);
      const first = service.toTxObject(row(), { binary: false });
      expect((first.meta as Record<string, unknown>).delivered_amount).toBe('300000000');
      // the same transaction in another ledger context (a partial payment before the fix) works out its own value
      const partial = rowOf('ripple-mock', MOCK_PAYMENT);
      const otherContext = service.toTxObject({ ...partial, ledger_index: 4594094 }, { binary: false });
      expect((otherContext.meta as Record<string, unknown>).delivered_amount).toBe('300000000');
      const again = service.toTxObject(row(), { binary: false });
      expect(again.meta).not.toBe(first.meta);
      expect((again.meta as Record<string, unknown>).delivered_amount).toBe('300000000');
    });

    it('does not cache at all when GH_TX_CACHE_SIZE is 0', async () => {
      const { service, codec } = await serviceFor('xrpl', noNode, 0);
      service.toTxObject(row(), { binary: false });
      const { encode } = spies(codec);
      service.toTxObject(row(), { binary: false });
      expect(encode).toHaveBeenCalledTimes(2); // transaction and metadata, again
    });

    it('holds at most GH_TX_CACHE_SIZE entries and drops the least recently used first', async () => {
      const { service, codec } = await serviceFor('xrpl', noNode, 2);
      const [a, b, c] = fixtureTransactions('ripple-mock')
        .slice(0, 3)
        .map((t) => t.row);
      for (const r of [a, b]) service.toTxObject(r, { binary: false });
      service.toTxObject(a, { binary: false }); // a is the most recent again
      service.toTxObject(c, { binary: false }); // evicts b
      const { encode } = spies(codec);
      service.toTxObject(a, { binary: false });
      service.toTxObject(c, { binary: false });
      expect(encode).not.toHaveBeenCalled();
      service.toTxObject(b, { binary: false });
      expect(encode).toHaveBeenCalledTimes(2);
    });

    it('is dropped when the codec switches to other definitions', async () => {
      const { service, codec } = await serviceFor('xrpl', noNode, 100);
      service.toTxObject(row(), { binary: false });
      service.toTxObject(row(), { binary: true });
      const { encode } = spies(codec);
      service.toTxObject(row(), { binary: false });
      expect(encode).not.toHaveBeenCalled();

      jest.spyOn(codec, 'generation', 'get').mockReturnValue(codec.generation + 1); // the node answered at last
      service.toTxObject(row(), { binary: false });
      service.toTxObject(row(), { binary: true });
      expect(encode).toHaveBeenCalledTimes(4);
      service.toTxObject(row(), { binary: false });
      expect(encode).toHaveBeenCalledTimes(4); // and fills again
    });

    it('does not cache a transaction that fell back: it is retried, counted and logged each time', async () => {
      const { service, prometheus } = await serviceFor('xrpl', noNode, 100);
      const stubborn = rowOf('ripple-mock', MOCK_PAYMENT, (tx) => {
        tx.Mystery = 'AB';
      });
      const counted = await fallbacksDuring(prometheus, () => {
        service.toTxObject(stubborn, { binary: false });
        service.toTxObject(stubborn, { binary: false });
      });
      expect(counted.json).toBe(2);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('is keyed by the transaction hash alone: a transaction never changes', async () => {
      const { service } = await serviceFor('xrpl', noNode, 100);
      service.toTxObject(row(), { binary: false });
      const stubborn = rowOf('ripple-mock', MOCK_PAYMENT, (tx) => {
        tx.Mystery = 'AB';
      });
      // same hash, other content: the cache is keyed by hash, as a transaction never changes
      expect(service.toTxObject(stubborn, { binary: false }).tx).not.toHaveProperty('Mystery');
    });
  });

  describe('toTxObjects: a page, converted without holding up the event loop (ruling R41)', () => {
    const page = (n: number) =>
      fixtureTransactions('ripple-mock')
        .slice(0, n)
        .map((t) => t.row);
    const yields = async (n: number) => {
      const { service } = await serviceFor('xrpl');
      const rows = page(n);
      const spy = jest.spyOn(global, 'setImmediate');
      await service.toTxObjects(rows, { binary: false });
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return calls;
    };

    it('is the same as toTxObject of each row, in order, with the ledger hash of each row', async () => {
      const { service } = await serviceFor('xrpl');
      const rows = page(30);
      const ledgerHashes = new Map(
        rows.slice(0, 20).map((r) => [r.ledger_index, `${r.ledger_index}`.padStart(64, '0')]),
      );
      for (const binary of [false, true]) {
        const objects = await service.toTxObjects(rows, { binary, ledgerHashes });
        expect(objects).toEqual(
          rows.map((r) => service.toTxObject(r, { binary, ledgerHash: ledgerHashes.get(r.ledger_index) })),
        );
        expect(objects.map((o) => o.hash)).toEqual(rows.map((r) => r.hash));
      }
      expect((await service.toTxObjects(rows, { binary: false, ledgerHashes }))[0]).toHaveProperty('ledger_hash');
      expect(await service.toTxObjects([], { binary: false })).toEqual([]);
    });

    it('lets other work run: a callback queued before the call has run before the page is returned', async () => {
      const { service } = await serviceFor('xrpl');
      let ran = false;
      setImmediate(() => {
        ran = true;
      });
      await service.toTxObjects(page(200), { binary: false });
      expect(ran).toBe(true);
    });

    it('does so every 50 transactions, not after the last one', async () => {
      expect(await yields(1)).toBe(0);
      expect(await yields(50)).toBe(0);
      expect(await yields(51)).toBe(1);
      expect(await yields(100)).toBe(1);
      expect(await yields(101)).toBe(2);
      expect(await yields(200)).toBe(3);
    });

    it('serves a stubborn transaction in the page like toTxObject does', async () => {
      const { service, prometheus } = await serviceFor('xrpl');
      const rows = page(60);
      rows[55] = rowOf('ripple-mock', MOCK_PAYMENT, (tx) => {
        tx.Mystery = 'AB';
      });
      let objects: Awaited<ReturnType<TxService['toTxObjects']>> = [];
      const counted = await fallbacksDuring(prometheus, async () => {
        objects = await service.toTxObjects(rows, { binary: true });
      });
      expect(objects).toHaveLength(60);
      expect(typeof objects[55].tx).toBe('object');
      expect(typeof objects[54].tx).toBe('string');
      expect(counted).toEqual({ json: 0, binary: 1 });
    });
  });
});
