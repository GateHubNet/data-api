import { getNetworkProfile, NetworkName, TransactionsRow } from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { BinaryCodecService } from '../src/common/binary-codec.service';
import { TxService } from '../src/common/tx-object';
import { PrometheusService } from '../src/modules/prometheus/prometheus.service';
import type { XrplService } from '../src/xrpl/xrpl.service';
import { Harness, startHarness } from './harness';
import { fixtureSource, fixtureTransactions, SeedName, transactionId, transactionTreeRoot } from './support/fixtures';

const MOCK_PAYMENT = '22F26CE4E2270CE3CF4EB61C609E7ADEDCD41D4C1BA2D96D680A9B016C4F47DA';

// The codec warns that it fell back to its built-in definitions; that is how these tests build it.
beforeAll(() => Logger.overrideLogger(false));

const noNode = { request: jest.fn().mockRejectedValue(new Error('No node connection')) } as unknown as XrplService;

async function servicesOf(
  h: Harness,
  network: NetworkName,
): Promise<{ service: TxService; codec: BinaryCodecService; prometheus: PrometheusService }> {
  const profile = getNetworkProfile(network);
  const codec = new BinaryCodecService(noNode, profile);
  await codec.onModuleInit();
  codec.onModuleDestroy();
  const prometheus = new PrometheusService();
  return { service: new TxService(h.ch, codec, profile, prometheus), codec, prometheus };
}

const keyOf = (row: Pick<TransactionsRow, 'ledger_index' | 'tx_index'>) => ({
  ledger_index: row.ledger_index,
  tx_index: row.tx_index,
});

describe.each<[SeedName, NetworkName]>([
  ['ripple-mock', 'xrpl'],
  ['xrpl-recorded', 'xrpl'],
  ['xahau-recorded', 'xahau'],
])('TxService on the %s ledgers', (seed, network) => {
  let h: Harness;
  let service: TxService;
  let codec: BinaryCodecService;
  let prometheus: PrometheusService;
  const all = fixtureTransactions(seed);

  beforeAll(async () => {
    h = await startHarness({ seed });
    ({ service, codec, prometheus } = await servicesOf(h, network));
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('fetchByKeys', () => {
    it('returns the stored rows, in the order of the keys, with one query', async () => {
      // keys in a scrambled order, across several ledgers
      const picked = all.filter((_, i) => i % 7 === 0).reverse();
      const shuffled = [...picked.slice(1), picked[0]];
      const query = jest.spyOn(h.ch, 'query');
      const rows = await service.fetchByKeys(shuffled.map((t) => keyOf(t.row)));
      expect(query).toHaveBeenCalledTimes(1);
      expect(rows).toHaveLength(shuffled.length);
      expect(rows.map(keyOf)).toEqual(shuffled.map((t) => keyOf(t.row)));
      for (const [i, row] of rows.entries()) {
        const { row: stored } = shuffled[i];
        expect(row).toEqual({ ...stored, fee: String(stored.fee), sequence: stored.sequence });
      }
    });

    it('binds the keys as parameters', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await service.fetchByKeys([keyOf(all[0].row)]);
      const [sql] = query.mock.calls[0];
      expect(String(sql)).not.toContain(String(all[0].row.ledger_index));
    });

    it('skips a key that has no transaction and answers nothing for no keys', async () => {
      const query = jest.spyOn(h.ch, 'query');
      expect(await service.fetchByKeys([])).toEqual([]);
      expect(query).not.toHaveBeenCalled();
      const rows = await service.fetchByKeys([
        { ledger_index: 1, tx_index: 0 },
        keyOf(all[1].row),
        { ledger_index: all[1].row.ledger_index, tx_index: 99999 },
      ]);
      expect(rows.map(keyOf)).toEqual([keyOf(all[1].row)]);
    });

    it('takes a full page of keys (the largest list endpoint asks for 1000) in one request', async () => {
      const real = all.map((t) => keyOf(t.row));
      const keys = Array.from({ length: 1500 }, (_, i) =>
        i % 3 === 0 ? { ledger_index: 1, tx_index: i } : real[i % real.length],
      );
      const rows = await service.fetchByKeys(keys);
      expect(rows).toHaveLength(keys.filter((_, i) => i % 3 !== 0).length);
      expect(rows.slice(0, 3).map(keyOf)).toEqual([
        real[1 % real.length],
        real[2 % real.length],
        real[4 % real.length],
      ]);
      const hashes = await service.ledgerHashes(
        Array.from({ length: 1500 }, (_, i) => all[i % all.length].row.ledger_index),
      );
      expect(hashes.size).toBe(fixtureSource(seed).list().length);
    });

    it('repeats a key that is asked twice', async () => {
      const key = keyOf(all[2].row);
      const rows = await service.fetchByKeys([key, keyOf(all[3].row), key]);
      expect(rows.map(keyOf)).toEqual([key, keyOf(all[3].row), key]);
    });
  });

  describe('ledgerHashes', () => {
    it('maps ledger indexes to their ledger hashes, in one query, leaving out unknown ones', async () => {
      const ledgers = fixtureSource(seed).list().slice(0, 4);
      const query = jest.spyOn(h.ch, 'query');
      const hashes = await service.ledgerHashes([
        ...ledgers.map((l) => l.header.ledger_index),
        7,
        ledgers[0].header.ledger_index,
      ]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(hashes).toBeInstanceOf(Map);
      expect(Object.fromEntries(hashes)).toEqual(
        Object.fromEntries(ledgers.map((l) => [l.header.ledger_index, l.header.ledger_hash])),
      );
    });

    it('answers an empty map without a query for no indexes', async () => {
      const query = jest.spyOn(h.ch, 'query');
      expect((await service.ledgerHashes([])).size).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('binary form of what is stored', () => {
    it('is built with the bundled definitions of the network when the node does not answer', () => {
      expect(codec.definitionsSource).toBe('profile');
    });

    it('hashes to the stored hash for every transaction', async () => {
      const rows = await service.fetchByKeys(all.map((t) => keyOf(t.row)));
      expect(rows).toHaveLength(all.length);
      for (const row of rows) {
        const obj = service.toTxObject(row, { binary: true });
        expect(transactionId(obj.tx as string)).toBe(row.hash);
      }
    });

    it('rebuilds the transaction_hash of every ledger from the binary tx and meta', async () => {
      // The tree of a ledger holds both blobs of every transaction, so the root only matches when the metadata
      // serialization is the node's, bit for bit.
      const headers = await h.ch.query<{ ledger_index: number; transaction_hash: string }>(
        'SELECT ledger_index, transaction_hash FROM ledgers ORDER BY ledger_index',
      );
      expect(headers).toHaveLength(fixtureSource(seed).list().length);
      for (const header of headers) {
        const ledger = all.filter((t) => t.row.ledger_index === header.ledger_index);
        const rows = await service.fetchByKeys(ledger.map((t) => keyOf(t.row)));
        const items = rows.map((row) => {
          const { tx, meta } = service.toTxObject(row, { binary: true });
          return { hash: row.hash, tx: tx as string, meta: meta as string };
        });
        expect(transactionTreeRoot(items)).toBe(header.transaction_hash);
      }
    });
  });

  it('serves every stored transaction in both modes without falling back to the stored JSON', async () => {
    const rows = await service.fetchByKeys(all.map((t) => keyOf(t.row)));
    const { values: before } = await prometheus.txEncodeFallback.get();
    for (const row of rows) {
      const json = service.toTxObject(row, { binary: false });
      expect(json.tx).toEqual(codec.decode(codec.encode(JSON.parse(row.tx_json))));
      expect(json.tx).not.toHaveProperty('DeliverMax');
      expect(typeof service.toTxObject(row, { binary: true }).tx).toBe('string');
    }
    expect((await prometheus.txEncodeFallback.get()).values).toEqual(before);
  });

  it('serves a fetched row as a TxObject with the ledger hash of its ledger', async () => {
    const { row } = all[0];
    const [fetched] = await service.fetchByKeys([keyOf(row)]);
    const hashes = await service.ledgerHashes([row.ledger_index]);
    const obj = service.toTxObject(fetched, { binary: false, ledgerHash: hashes.get(row.ledger_index) });
    expect(obj).toMatchObject({
      hash: row.hash,
      ledger_index: row.ledger_index,
      ledger_hash: fixtureSource(seed).list()[0].header.ledger_hash,
    });
    expect(obj.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  });
});

describe('TxService.toTxObject on a fetched mainnet Payment', () => {
  let h: Harness;
  let service: TxService;
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock' });
    ({ service } = await servicesOf(h, 'xrpl'));
  });
  afterAll(async () => {
    await h?.close();
  });

  it('injects delivered_amount from the stored rows and leaves OfferCreate alone', async () => {
    const payment = fixtureTransactions('ripple-mock').find((t) => t.tx.hash === MOCK_PAYMENT)!;
    const offer = fixtureTransactions('ripple-mock').find((t) => t.row.tx_type === 'OfferCreate')!;
    const [p, o] = await service.fetchByKeys([keyOf(payment.row), keyOf(offer.row)]);
    expect((service.toTxObject(p, { binary: false }).meta as Record<string, unknown>).delivered_amount).toBe(
      '300000000',
    );
    expect(service.toTxObject(o, { binary: false }).meta).not.toHaveProperty('delivered_amount');
  });
});
