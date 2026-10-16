import { ClickHouseService, ShutdownSignals, Table } from '@gatehub/data-api-shared';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { WORKER_MODULES } from '../worker-registry';
import { AggregatorModule } from './aggregator.module';
import { AggregatorService } from './aggregator.service';

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };

describe('AggregatorModule', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the module of the aggregator worker', () => {
    expect(WORKER_MODULES.aggregator).toBe(AggregatorModule);
  });

  it('starts the service with what the core module provides, and stops it when the app closes', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T12:34:56Z') });
    const query = jest.fn(async (sql: string) => {
      if (sql.includes(`FROM ${Table.StatsHourly}`)) return [{ hour: null }];
      return [];
    });
    const insert = jest.fn(async () => undefined);
    const shutdown = { register: jest.fn() };
    const metrics = { aggregatorRunsTotal: { inc: jest.fn() }, aggregatorErrorsTotal: { inc: jest.fn() } };
    // what the global core module and the ClickHouse module provide to every worker
    @Global()
    @Module({
      providers: [
        {
          provide: ClickHouseService,
          useValue: { query, queryOne: async (sql: string) => (await query(sql))[0], insert },
        },
        { provide: PrometheusService, useValue: metrics },
        { provide: ShutdownSignals, useValue: shutdown },
      ],
      exports: [ClickHouseService, PrometheusService, ShutdownSignals],
    })
    class CoreStub {}
    const moduleRef = await Test.createTestingModule({ imports: [CoreStub, AggregatorModule] })
      .setLogger(QUIET)
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(app.get(AggregatorService)).toBeInstanceOf(AggregatorService);
    expect(shutdown.register).toHaveBeenCalledWith('aggregator', expect.any(Function));

    await jest.advanceTimersByTimeAsync(0);
    const queries = query.mock.calls.length;
    expect(queries).toBeGreaterThan(0);
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'stats_live' });
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'stats_dirty' });

    await app.close();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(query.mock.calls.length).toBe(queries);
  });
});
