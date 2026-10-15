import { ClickHouseService, ParsedTransaction, runMigrations, Table } from '@gatehub/data-api-shared';
import { ClickHouseDataProcessorService } from '../src/processor/clickhouse-data-processor.service';
import { SyncerConfig } from '../src/config/syncer.config';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';

function syntheticLedger(index: number): any {
  return {
    ledger_index: index,
    ledger_hash: `HASH_${index}`,
    parent_hash: 'PARENT',
    account_hash: 'ACCT',
    transaction_hash: 'TXROOT',
    total_coins: '99000000000000000',
    close_time: 1_717_243_200, // unix seconds (set by the worker)
    close_time_human: '',
    close_time_resolution: 10,
    close_flags: 0,
    parent_close_time: 1_717_243_190,
  };
}

function syntheticParsed(index: number): ParsedTransaction {
  return {
    rawTransaction: {
      hash: `TX_${index}`,
      ledger_index: index,
      date: 1_717_243_200,
      TransactionType: 'Payment',
      Account: 'rA',
      Destination: 'rB',
      meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0 } as any,
    } as any,
    payment: {
      source: 'rA',
      destination: 'rB',
      source_balance_changes: [],
      destination_balance_changes: [],
      currency: 'USD',
      amount: '100',
      delivered_amount: '100',
      fee: '0.1',
      ledger_index: index,
      tx_index: 0,
      date: 1_717_243_200,
      tx_hash: `TX_${index}`,
    },
    exchanges: [],
    balanceChanges: [],
    accountsCreated: [],
    affectedAccounts: [],
    offers: [],
    issuers: [],
  };
}

describe('ClickHouseDataProcessor (e2e)', () => {
  let ch: StartedClickHouse;
  let chService: ClickHouseService;
  let processor: ClickHouseDataProcessorService;

  const config = { networkId: 0 } as SyncerConfig;

  beforeAll(async () => {
    ch = await startClickHouse('xrpl');
    await runMigrations();
    chService = new ClickHouseService({ url: ch.url, username: 'default', password: '', database: ch.database, requestTimeout: 30000, maxOpenConnections: 5, maxExecutionTime: 30, maxQueryMemoryBytes: 0 });
    processor = new ClickHouseDataProcessorService(chService, config);
  }, 180_000);

  afterAll(async () => {
    await chService?.onModuleDestroy();
    await ch?.container.stop();
  });

  const count = async (table: string): Promise<number> => {
    const r = await chService.queryOne<{ c: string }>(`SELECT count() AS c FROM ${table}`);
    return Number(r?.c ?? 0);
  };

  it('batches and flushes buffered ledgers', async () => {
    for (let i = 1000; i < 1005; i++) processor.enqueueLedger(syntheticLedger(i), [syntheticParsed(i)]);
    expect(processor.bufferedLedgerCount).toBe(5);
    await processor.flush();
    expect(processor.bufferedLedgerCount).toBe(0);

    expect(await count(Table.Ledgers)).toBe(5);
    expect(await count(Table.Payments)).toBe(5);
    expect(await count(Table.Transactions)).toBe(5);
  });

  it('is idempotent: re-ingesting the same ledgers does not create duplicates', async () => {
    for (let i = 1000; i < 1005; i++) processor.enqueueLedger(syntheticLedger(i), [syntheticParsed(i)]);
    await processor.flush();

    // ReplacingMergeTree collapses by ctid/key under FINAL.
    const distinctLedgers = await chService.queryOne<{ c: string }>(`SELECT count() AS c FROM ${Table.Ledgers} FINAL`);
    const distinctPayments = await chService.queryOne<{ c: string }>(`SELECT countDistinct(ctid) AS c FROM ${Table.Payments}`);
    expect(Number(distinctLedgers?.c)).toBe(5);
    expect(Number(distinctPayments?.c)).toBe(5);
  });

  it('reports inserted ledgers for the skip-window query', async () => {
    const inserted = await processor.getInsertedLedgers(1000, 1004);
    expect(inserted.size).toBe(5);
    expect(inserted.has(1002)).toBe(true);
  });
});
