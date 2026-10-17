import { ClickHouseService, getNetworkProfile, ShutdownSignals, Table } from '@gatehub/data-api-shared';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORK_PROFILE } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { WORKER_MODULES } from '../worker-registry';
import { AggregatorModule } from './aggregator.module';
import { AggregatorService } from './aggregator.service';

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };

describe('AggregatorModule', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.GH_MARKETS_CONFIG;
  });

  /** What the global core module and the ClickHouse module provide to every worker, over fakes. */
  function coreStub(query: jest.Mock, insert: jest.Mock, shutdown: { register: jest.Mock }, metrics: object) {
    @Global()
    @Module({
      providers: [
        {
          provide: ClickHouseService,
          useValue: { query, queryOne: async (sql: string) => (await query(sql))[0], insert },
        },
        { provide: PrometheusService, useValue: metrics },
        { provide: ShutdownSignals, useValue: shutdown },
        { provide: NETWORK_PROFILE, useValue: getNetworkProfile('xrpl') },
      ],
      exports: [ClickHouseService, PrometheusService, ShutdownSignals, NETWORK_PROFILE],
    })
    class CoreStub {}
    return CoreStub;
  }

  it('is the module of the aggregator worker', () => {
    expect(WORKER_MODULES.aggregator).toBe(AggregatorModule);
  });

  it('starts the service with what the core module provides, and stops it when the app closes', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T12:34:56Z') });
    const query = jest.fn(async (sql: string) => {
      if (sql.includes(`FROM ${Table.StatsHourly}`)) return [{ hour: null }];
      return [];
    });
    const insert = jest.fn(async (_table: string, _rows: unknown[]) => undefined);
    const shutdown = { register: jest.fn() };
    const metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
    };
    const CoreStub = coreStub(query, insert, shutdown, metrics);
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
    // the volume jobs are on, with the bundled markets config of the network
    for (const job of ['volume_live', 'volume_daily', 'volume_backfill']) {
      expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job });
    }
    // and so is the AMM pools job, which has nothing to rebuild over an empty database
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
    // and the AMM daily job, which runs at the first tick: today and yesterday, each a sentinel without any pool
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    const written = insert.mock.calls.map(([table]) => table);
    // the three metrics: 5 + 2 + 5 live sets, and today and yesterday of each
    expect(written.filter((table) => table === Table.VolumeLive)).toHaveLength(12);
    expect(written.filter((table) => table === Table.VolumeDaily)).toHaveLength(6);
    expect(written).not.toContain(Table.AmmPools);
    const days = insert.mock.calls.filter(([table]) => table === Table.AmmDaily);
    expect(
      days.map(([, rows]) => (rows as Array<{ day: string; amm_account: string }>).map((r) => [r.day, r.amm_account])),
    ).toEqual([[['2026-10-16', '']], [['2026-10-15', '']]]);

    await app.close();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(query.mock.calls.length).toBe(queries);
  });

  it('reads the markets config from GH_MARKETS_CONFIG, and its version is the version of the sets', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T12:34:56Z') });
    const dir = mkdtempSync(join(tmpdir(), 'markets-'));
    try {
      const file = join(dir, 'markets.json');
      writeFileSync(file, JSON.stringify({ version: 42, tradeMarkets: [], paymentCurrencies: [] }));
      process.env.GH_MARKETS_CONFIG = file;
      const query = jest.fn(async () => [] as unknown[]);
      const insert = jest.fn(async (_table: string, _rows: unknown[]) => undefined);
      const CoreStub = coreStub(
        query,
        insert,
        { register: jest.fn() },
        {
          aggregatorRunsTotal: { inc: jest.fn() },
          aggregatorErrorsTotal: { inc: jest.fn() },
          aggregatorStatsLagSeconds: { set: jest.fn() },
        },
      );
      const moduleRef = await Test.createTestingModule({ imports: [CoreStub, AggregatorModule] })
        .setLogger(QUIET)
        .compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      await jest.advanceTimersByTimeAsync(0);
      const sets = insert.mock.calls.filter(([table]) => table === Table.VolumeLive);
      expect(sets).toHaveLength(12);
      for (const [, rows] of sets) {
        expect((rows as Array<{ config_version: number }>).every((row) => row.config_version === 42)).toBe(true);
      }
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to boot on a markets config that is not valid, and says what is wrong with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'markets-'));
    try {
      const file = join(dir, 'markets.json');
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          tradeMarkets: [{ base: { currency: 'USD' }, counter: { currency: 'XRP' } }],
          paymentCurrencies: [],
        }),
      );
      process.env.GH_MARKETS_CONFIG = file;
      const CoreStub = coreStub(jest.fn(), jest.fn(), { register: jest.fn() }, {});
      const building = Test.createTestingModule({ imports: [CoreStub, AggregatorModule] })
        .setLogger(QUIET)
        .compile();
      await expect(building).rejects.toThrow('Invalid markets config: tradeMarkets[0].base');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
