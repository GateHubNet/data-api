import { ClickHouseService, getNetworkProfile, NodeClient, ShutdownSignals, Table } from '@gatehub/data-api-shared';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { NETWORK_PROFILE, SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { WORKER_MODULES } from '../worker-registry';
import { VALIDATIONS_COLLECTOR_OPTIONS, ValidationsCollector } from './validations-collector';
import { ValidationsModule } from './validations.module';

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };

describe('ValidationsModule', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the module of the validations worker', () => {
    expect(WORKER_MODULES.validations).toBe(ValidationsModule);
  });

  it('starts the collector with what the core module provides, and stops it when the app closes', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T12:00:00.123Z') });
    const node = Object.assign(new EventEmitter(), {
      subscribe: jest.fn(async () => undefined),
      start: jest.fn(async () => {
        node.emit('connected', 'ws://node-a:6006');
      }),
      stop: jest.fn(async () => undefined),
      serverInfo: jest.fn(async () => ({ complete_ledgers: '1-2', pubkey_node: 'n9Reporter' })),
      request: jest.fn(async () => ({})),
    });
    const insert = jest.fn(
      async (_table: Table | string, _rows: unknown[], _opts?: unknown): Promise<void> => undefined,
    );
    const query = jest.fn(async () => []);
    const shutdown = { register: jest.fn() };
    const metrics = {
      validationsFlushedTotal: { inc: jest.fn() },
      validationsErrorsTotal: { inc: jest.fn() },
      validationsDroppedTotal: { inc: jest.fn() },
      validatorValidationsFlushedTotal: { inc: jest.fn() },
    };
    // what the global core module and the ClickHouse module provide to every worker
    @Global()
    @Module({
      providers: [
        { provide: SyncerConfig, useValue: { validationEndpoints: 'ws://node-a:6006' } },
        { provide: NETWORK_PROFILE, useValue: getNetworkProfile('xrpl') },
        { provide: ClickHouseService, useValue: { insert, query } },
        { provide: PrometheusService, useValue: metrics },
        { provide: ShutdownSignals, useValue: shutdown },
        {
          provide: VALIDATIONS_COLLECTOR_OPTIONS,
          useValue: { logger: QUIET, makeClient: () => node as unknown as NodeClient },
        },
      ],
      exports: [
        SyncerConfig,
        NETWORK_PROFILE,
        ClickHouseService,
        PrometheusService,
        ShutdownSignals,
        VALIDATIONS_COLLECTOR_OPTIONS,
      ],
    })
    class CoreStub {}
    const moduleRef = await Test.createTestingModule({ imports: [CoreStub, ValidationsModule] })
      .setLogger(QUIET)
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const collector = app.get(ValidationsCollector);
    expect(collector).toBeInstanceOf(ValidationsCollector);
    expect(shutdown.register).toHaveBeenCalledWith('validations-collector', expect.any(Function));
    await jest.advanceTimersByTimeAsync(0);
    expect(node.subscribe).toHaveBeenCalledWith(['validations', 'manifests']);
    expect(node.start).toHaveBeenCalledTimes(1);

    node.emit('manifestReceived', {
      master_key: 'nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6',
      signing_key: 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy',
      seq: 1,
    });
    node.emit('validationReceived', {
      ledger_hash: '9373383605D0994AF33ACECA206693B331BA61C3CDA511AF3E7DD569593E126C',
      validation_public_key: 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy',
      master_key: 'nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6',
      ledger_index: '46087342',
      full: true,
    });
    await jest.advanceTimersByTimeAsync(20_000);
    // a flush writes the four tables, in this order
    expect(insert.mock.calls.map(([table]) => table)).toEqual([
      Table.ValidatorManifests,
      Table.Validations,
      Table.ValidatorValidations,
      Table.ValidatorSeen,
    ]);
    expect(insert).toHaveBeenCalledWith(Table.Validations, [
      expect.objectContaining({ count: 1, reporter_public_key: 'n9Reporter' }),
    ]);
    expect(insert).toHaveBeenCalledWith(
      Table.ValidatorValidations,
      [expect.objectContaining({ count: 1, ledger_index: 46087342, full: 1, server_version: null })],
      { dedupToken: expect.stringMatching(/^vc:.+:validator_validations:1$/) },
    );
    expect(insert).toHaveBeenCalledWith(
      Table.ValidatorSeen,
      [expect.objectContaining({ last_ledger_index: 46087342 })],
      { dedupToken: expect.stringMatching(/^vc:.+:validator_seen:1$/) },
    );

    node.emit('validationReceived', {
      ledger_hash: '9373383605D0994AF33ACECA206693B331BA61C3CDA511AF3E7DD569593E126C',
      validation_public_key: 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy',
      master_key: 'nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6',
    });
    await app.close(); // the final flush: no manifest is waiting, so three tables
    expect(insert).toHaveBeenCalledTimes(4 + 3);
    expect(insert.mock.calls.slice(4).map(([table]) => table)).toEqual([
      Table.Validations,
      Table.ValidatorValidations,
      Table.ValidatorSeen,
    ]);
    expect(node.stop).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(insert).toHaveBeenCalledTimes(4 + 3);
  });
});
