import { ClickHouseService, getNetworkProfile, NetworkName, TransactionsRow } from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { fixtureTransaction, fixtureTransactions, SeedName, transactionId } from '../../test/support/fixtures';
import type { XrplService } from '../xrpl/xrpl.service';
import { BinaryCodecService } from './binary-codec.service';
import { TxService } from './tx-object';

const MOCK_PAYMENT = '22F26CE4E2270CE3CF4EB61C609E7ADEDCD41D4C1BA2D96D680A9B016C4F47DA';
const XAHAU_CLAIM_REWARD = '3A1F25CDF0E2E4466AA0B019EA3039A6E5F87C01FBDD69CBDC474DAC32D8E64C';

const noNode = { request: jest.fn().mockRejectedValue(new Error('No node connection')) } as unknown as XrplService;

// The codec warns that it fell back to its built-in definitions; that is how these tests build it.
beforeAll(() => Logger.overrideLogger(false));

async function serviceFor(network: NetworkName): Promise<{ service: TxService; codec: BinaryCodecService }> {
  const profile = getNetworkProfile(network);
  const codec = new BinaryCodecService(noNode, profile);
  await codec.onModuleInit();
  codec.onModuleDestroy(); // no retry timer in a unit test
  return { service: new TxService({} as ClickHouseService, codec, profile), codec };
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

const TF_PARTIAL_PAYMENT = 0x00020000;
const GBP = { currency: 'GBP', issuer: 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q', value: '12.5' };

describe('TxService.toTxObject', () => {
  describe('JSON mode', () => {
    it('serves the stored transaction and metadata with the ledger fields of the Ripple API, in its field order', async () => {
      const { service } = await serviceFor('xrpl');
      const fixture = fixtureTransaction('ripple-mock', MOCK_PAYMENT);
      const obj = service.toTxObject(fixture.row, { binary: false });
      expect(Object.keys(obj)).toEqual(['hash', 'ledger_index', 'date', 'tx', 'meta']);
      expect(obj.hash).toBe(MOCK_PAYMENT);
      expect(obj.ledger_index).toBe(11119603);
      expect(obj.date).toBe('2015-01-14T18:27:20+00:00');
      expect(obj.tx).toEqual(fixture.tx.tx);
      expect(obj.meta).toEqual({ ...fixture.tx.meta, delivered_amount: '300000000' });
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

    it('uses the Xahau definitions on Xahau', async () => {
      const { service } = await serviceFor('xahau');
      const { row } = fixtureTransaction('xahau-recorded', XAHAU_CLAIM_REWARD);
      const obj = service.toTxObject(row, { binary: true });
      expect(transactionId(obj.tx as string)).toBe(XAHAU_CLAIM_REWARD);
    });
  });
});
