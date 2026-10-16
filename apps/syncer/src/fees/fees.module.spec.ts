import { ClickHouseService, ShutdownSignals, Table } from '@gatehub/data-api-shared';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NODE_CLIENT } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { WORKER_MODULES } from '../worker-registry';
import { FeeStatsPoller } from './fee-stats-poller';
import { FeesModule } from './fees.module';

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };

describe('FeesModule', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the module of the fee_stats worker', () => {
    expect(WORKER_MODULES.fee_stats).toBe(FeesModule);
  });

  it('starts the poller with what the core module provides, and stops it when the app closes', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T12:00:00.123Z') });
    const request = jest.fn(async () => ({
      current_ledger_size: '46',
      current_queue_size: '13',
      expected_ledger_size: '24',
      max_queue_size: '480',
      drops: { median_fee: '5000', minimum_fee: '10', open_ledger_fee: '12' },
    }));
    const insert = jest.fn(async () => undefined);
    const shutdown = { register: jest.fn() };
    const metrics = { feeStatsSamplesTotal: { inc: jest.fn() }, feeStatsErrorsTotal: { inc: jest.fn() } };
    // what the global core module and the ClickHouse module provide to every worker
    @Global()
    @Module({
      providers: [
        { provide: NODE_CLIENT, useValue: { request } },
        { provide: ClickHouseService, useValue: { insert } },
        { provide: PrometheusService, useValue: metrics },
        { provide: ShutdownSignals, useValue: shutdown },
      ],
      exports: [NODE_CLIENT, ClickHouseService, PrometheusService, ShutdownSignals],
    })
    class CoreStub {}
    const moduleRef = await Test.createTestingModule({ imports: [CoreStub, FeesModule] })
      .setLogger(QUIET)
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(app.get(FeeStatsPoller)).toBeInstanceOf(FeeStatsPoller);
    expect(shutdown.register).toHaveBeenCalledWith('fee-stats', expect.any(Function));

    await jest.advanceTimersByTimeAsync(5_000);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledWith(Table.FeeStats, [expect.objectContaining({ pct_max_queue_size: 2.71 })]);
    expect(metrics.feeStatsSamplesTotal.inc).toHaveBeenCalledTimes(2);

    await app.close();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
