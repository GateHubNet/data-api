import { AmendmentsConfig, ClickHouseService, getNetworkProfile, ShutdownSignals } from '@gatehub/data-api-shared';
import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { join } from 'path';
import { NETWORK_PROFILE, NODE_CLIENT, SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { NetworkStatePoller } from './network-state-poller';
import { AMENDMENTS_CONFIG, ValidatorsModule } from './validators.module';

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };
const SHIPPED = join(__dirname, '../../../../packages/shared/config/amendments');
/** RequireFullyCanonicalSig: named in the amendment metadata of both networks. */
const REQUIRE_FULLY_CANONICAL_SIG = '00C1FC4A53E60AB02C864641002B3172F38677E29C26C5406685179B37E1EDAC';

const made: TestingModule[] = [];

/** The module as the application builds it, over a core stub: no connection, no loop (the app is not initialised). */
async function build(network: 'xrpl' | 'xahau', amendmentsConfig: string): Promise<TestingModule> {
  // what the global core module provides to every worker
  @Global()
  @Module({
    providers: [
      {
        provide: SyncerConfig,
        useValue: Object.assign(new SyncerConfig(), { network, unlPublishers: '', amendmentsConfig }),
      },
      { provide: NETWORK_PROFILE, useValue: getNetworkProfile(network) },
      { provide: NODE_CLIENT, useValue: { request: jest.fn() } },
      { provide: ClickHouseService, useValue: { query: jest.fn(), insert: jest.fn() } },
      { provide: PrometheusService, useValue: {} },
      { provide: ShutdownSignals, useValue: { register: jest.fn() } },
    ],
    exports: [SyncerConfig, NETWORK_PROFILE, NODE_CLIENT, ClickHouseService, PrometheusService, ShutdownSignals],
  })
  class CoreStub {}
  const moduleRef = await Test.createTestingModule({ imports: [CoreStub, ValidatorsModule] })
    .setLogger(QUIET)
    .compile();
  made.push(moduleRef);
  return moduleRef;
}

describe('ValidatorsModule', () => {
  afterEach(async () => {
    await Promise.all(made.splice(0).map((moduleRef) => moduleRef.close()));
  });

  it('provides the network state poller', async () => {
    const moduleRef = await build('xrpl', '');
    expect(moduleRef.get(NetworkStatePoller)).toBeInstanceOf(NetworkStatePoller);
  });

  describe('AMENDMENTS_CONFIG', () => {
    const configOf = (moduleRef: TestingModule) => moduleRef.get<AmendmentsConfig>(AMENDMENTS_CONFIG);

    it('is the file shipped for the network when GH_AMENDMENTS_CONFIG is empty', async () => {
      const xrpl = configOf(await build('xrpl', ''));
      expect(xrpl.network).toBe('xrpl');
      expect(xrpl.byId.get(REQUIRE_FULLY_CANONICAL_SIG)?.name).toBe('RequireFullyCanonicalSig');
      expect(configOf(await build('xahau', '')).network).toBe('xahau');
    });

    it('is the file GH_AMENDMENTS_CONFIG names', async () => {
      const config = configOf(await build('xahau', join(SHIPPED, 'xahau.json')));
      expect(config.network).toBe('xahau');
      expect(config.byId.get(REQUIRE_FULLY_CANONICAL_SIG)?.name).toBe('RequireFullyCanonicalSig');
    });

    it('fails the boot when the file is missing', async () => {
      const path = join(SHIPPED, 'no-such-file.json');
      await expect(build('xrpl', path)).rejects.toThrow(/Invalid amendments config: .*no-such-file\.json/);
    });

    it('fails the boot when the file is not an amendments config', async () => {
      const path = join(__dirname, '../../package.json');
      await expect(build('xrpl', path)).rejects.toThrow(/Invalid amendments config: .*package\.json/);
    });

    it('fails the boot when the file is of the other network', async () => {
      await expect(build('xrpl', join(SHIPPED, 'xahau.json'))).rejects.toThrow(
        /Invalid amendments config: network: "xahau" is not the network of this deployment, "xrpl"/,
      );
    });
  });
});
