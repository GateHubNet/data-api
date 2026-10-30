import {
  ClickHouseService,
  getNetworkProfile,
  NFT_VOLUME_CONFIG_VERSION,
  RatesService,
  ShutdownSignals,
  Table,
} from '@gatehub/data-api-shared';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORK_PROFILE, SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { WORKER_MODULES } from '../worker-registry';
import { AggregatorModule, aggregatorOptions } from './aggregator.module';
import { AggregatorService } from './aggregator.service';

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };

/** The metrics of the aggregator, of the account and market jobs, of the NFT jobs, of the escrows job, of the tokens job and of the supply job, over fakes. */
const fakeMetrics = () => ({
  aggregatorRunsTotal: { inc: jest.fn() },
  aggregatorErrorsTotal: { inc: jest.fn() },
  aggregatorStatsLagSeconds: { set: jest.fn() },
  pairHourlyMissingHours: { set: jest.fn() },
  marketsLiveAgeSeconds: { set: jest.fn() },
  marketsLiveAmmShareKnown: { set: jest.fn() },
  ratesDailyMissingDays: { set: jest.fn() },
  accountRollupsHeavyAccounts: { set: jest.fn() },
  accountRollupsPendingAccounts: { set: jest.fn() },
  nftStateLagLedgers: { set: jest.fn() },
  nftDirtyLedgers: { set: jest.fn() },
  nftCollectionsPending: { set: jest.fn() },
  escrowsLagLedgers: { set: jest.fn() },
  escrowsOpen: { set: jest.fn() },
  tokensLive: { set: jest.fn() },
  tokensLagLedgers: { set: jest.fn() },
  tokensBuilding: { set: jest.fn() },
  tokensRepairLedgers: { set: jest.fn() },
  supplySnapshotAgeSeconds: { set: jest.fn() },
  supplyCycleSeconds: { set: jest.fn() },
});

describe('AggregatorModule', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.GH_MARKETS_CONFIG;
  });

  /** What the global core module and the ClickHouse module provide to every worker, over fakes. */
  function coreStub(
    query: jest.Mock,
    insert: jest.Mock,
    shutdown: { register: jest.Mock },
    metrics: object,
    config: Partial<SyncerConfig> = { accountRollupMinRows: 1_000_000 },
  ) {
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
        { provide: SyncerConfig, useValue: config },
      ],
      exports: [ClickHouseService, PrometheusService, ShutdownSignals, NETWORK_PROFILE, SyncerConfig],
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
    const metrics = fakeMetrics();
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
    // and the NFT state job, which has nothing to rebuild over an empty database, and sets its gauges
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
    expect(metrics.nftStateLagLedgers.set).toHaveBeenCalledWith(0);
    expect(metrics.nftDirtyLedgers.set).toHaveBeenCalledWith(0);
    // and the escrows job, which has nothing to rebuild over an empty database, writes the sentinel of its first step (the
    // watermark at 0, nothing escrowed) and sets its gauges
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'escrows' });
    expect(metrics.escrowsLagLedgers.set).toHaveBeenCalledWith(0);
    expect(metrics.escrowsOpen.set).toHaveBeenCalledWith(0);
    // and the tokens job, which has no ledger to build a generation from over an empty database, and sets its four gauges
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'tokens' });
    for (const gauge of [
      metrics.tokensLive,
      metrics.tokensLagLedgers,
      metrics.tokensBuilding,
      metrics.tokensRepairLedgers,
    ]) {
      expect(gauge.set).toHaveBeenCalledWith(0);
    }
    // and the supply job, which finds no snapshot and no escrows sentinel in an empty database: its start waits, and it knows no
    // snapshot, so it sets neither of its gauges
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'supply' });
    expect(metrics.supplySnapshotAgeSeconds.set).not.toHaveBeenCalled();
    expect(metrics.supplyCycleSeconds.set).not.toHaveBeenCalled();
    // and the NFT collections job, which finds no collection behind in an empty database and sets its gauge
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'nft_collections' });
    expect(metrics.nftCollectionsPending.set).toHaveBeenCalledWith(0);
    // and the AMM daily job, which runs at the first tick: today and yesterday, each a sentinel without any pool
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
    // and so are the account and market jobs, which have nothing to do on a database without a ledger
    for (const job of ['pair_hourly', 'markets_live', 'rates_daily', 'account_rollups']) {
      expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job });
    }
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    const written = insert.mock.calls.map(([table]) => table);
    // the four metrics: 5 + 2 + 5 + 3 live sets, and today and yesterday of each
    expect(written.filter((table) => table === Table.VolumeLive)).toHaveLength(15);
    expect(written.filter((table) => table === Table.VolumeDaily)).toHaveLength(8);
    expect(written).not.toContain(Table.AmmPools);
    // no ledger, so no generation is started
    expect(written).not.toContain(Table.TokenGenerations);
    const sentinels = insert.mock.calls.filter(([table]) => table === Table.Escrows);
    expect(sentinels.map(([, rows]) => rows)).toEqual([
      [expect.objectContaining({ escrow_id: '', amount_drops: '0', open_count: 0, through_ledger: 0 })],
    ]);
    const days = insert.mock.calls.filter(([table]) => table === Table.AmmDaily);
    expect(
      days.map(([, rows]) => (rows as Array<{ day: string; amm_account: string }>).map((r) => [r.day, r.amm_account])),
    ).toEqual([[['2026-10-16', '']], [['2026-10-15', '']]]);

    await app.close();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(query.mock.calls.length).toBe(queries);
  });

  it('reads the markets config from GH_MARKETS_CONFIG, and its version is the version of the sets (the NFT volume has its own)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T12:34:56Z') });
    const dir = mkdtempSync(join(tmpdir(), 'markets-'));
    try {
      const file = join(dir, 'markets.json');
      writeFileSync(file, JSON.stringify({ version: 42, tradeMarkets: [], paymentCurrencies: [] }));
      process.env.GH_MARKETS_CONFIG = file;
      const query = jest.fn(async () => [] as unknown[]);
      const insert = jest.fn(async (_table: string, _rows: unknown[]) => undefined);
      const CoreStub = coreStub(query, insert, { register: jest.fn() }, fakeMetrics());
      const moduleRef = await Test.createTestingModule({ imports: [CoreStub, AggregatorModule] })
        .setLogger(QUIET)
        .compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      await jest.advanceTimersByTimeAsync(0);
      const sets = insert.mock.calls.filter(([table]) => table === Table.VolumeLive);
      expect(sets).toHaveLength(15);
      for (const [, rows] of sets) {
        const set = rows as Array<{ metric: string; config_version: number }>;
        // the markets config does not move the NFT volume: its sets carry the version of the metric
        const expected = set[0].metric === 'nft_volume' ? NFT_VOLUME_CONFIG_VERSION : 42;
        expect(set.every((row) => row.metric === set[0].metric && row.config_version === expected)).toBe(true);
      }
      expect(sets.filter(([, rows]) => (rows as Array<{ metric: string }>)[0].metric === 'nft_volume')).toHaveLength(3);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the volume jobs and the account and market jobs one RatesService, and the minimum of the config', () => {
    const ch = {} as ClickHouseService;
    const profile = getNetworkProfile('xrpl');
    const log = jest.fn();
    const options = aggregatorOptions(ch, profile, { accountRollupMinRows: 1234 } as SyncerConfig, { log } as never);
    expect(options.volumes?.rates).toBeInstanceOf(RatesService);
    expect(options.aggregates?.rates).toBe(options.volumes?.rates);
    expect(options.aggregates?.rates.nativeCurrency).toBe('XRP');
    expect(options.aggregates?.accountRollupMinRows).toBe(1234);
    // and the NFT job the same rates, with the daily rates over them
    expect(options.nfts?.rates).toBe(options.volumes?.rates);
    expect(options.nfts?.dailyRates.nativeCurrency).toBe('XRP');
    // and the escrows job the same rates, with the native currency of the network
    expect(options.escrows?.rates).toBe(options.volumes?.rates);
    expect(options.escrows?.nativeCurrency).toBe('XRP');
    expect(log).toHaveBeenCalledWith(
      'Escrows job on: the current state of every escrow and the escrowed total, from object_changes',
    );
    expect(
      aggregatorOptions(
        ch,
        getNetworkProfile('xahau'),
        { accountRollupMinRows: 1 } as SyncerConfig,
        {
          log: jest.fn(),
        } as never,
      ).escrows?.nativeCurrency,
    ).toBe('XAH');
    expect(
      aggregatorOptions(ch, profile, { accountRollupMinRows: 0 } as SyncerConfig, { log: jest.fn() } as never)
        .aggregates?.accountRollupMinRows,
    ).toBe(0);
  });

  it('turns the tokens job on with the profile and the rates', () => {
    const ch = {} as ClickHouseService;
    const profile = getNetworkProfile('xrpl');
    const log = jest.fn();
    const options = aggregatorOptions(ch, profile, { accountRollupMinRows: 1234 } as SyncerConfig, { log } as never);
    // the profile of the network (the tomls its tokens are matched with) and the one RatesService the other jobs share
    expect(options.tokens?.profile).toBe(profile);
    expect(options.tokens?.rates).toBe(options.volumes?.rates);
    // the knobs are the tests': the job's own defaults hold
    expect(options.tokens?.configVersion).toBeUndefined();
    expect(options.tokens?.retiredKeepMs).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Tokens job on: /));
    const xahau = getNetworkProfile('xahau');
    expect(
      aggregatorOptions(ch, xahau, { accountRollupMinRows: 1 } as SyncerConfig, { log: jest.fn() } as never).tokens
        ?.profile,
    ).toBe(xahau);
  });

  it('turns the supply job on with the profile of the network', () => {
    const ch = {} as ClickHouseService;
    const log = jest.fn();
    for (const network of ['xrpl', 'xahau'] as const) {
      const profile = getNetworkProfile(network);
      const options = aggregatorOptions(ch, profile, { accountRollupMinRows: 1 } as SyncerConfig, { log } as never);
      // the profile says whether the network has an AMM (the sight of the amm_pools runner is the service's to lend) and mints
      expect(options.supply?.profile).toBe(profile);
      expect(options.supply?.ammSight).toBeUndefined();
    }
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Supply job on: /));
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
