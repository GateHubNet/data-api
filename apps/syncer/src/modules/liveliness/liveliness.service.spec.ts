import { ClickHouseService } from '@gatehub/data-api-shared';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { SyncerConfig } from '../../config/syncer.config';
import { INGEST_STATUS, IngestStatus } from './ingest-status';
import { LivelinessService } from './liveliness.service';

const MAX_LAG = 10;
const MINUTE = 60_000;

interface Harness {
  service: LivelinessService;
  ping: jest.Mock;
  ingest: { status: jest.Mock };
}

async function setup(opts: { withIngest: boolean }): Promise<Harness> {
  const ping = jest.fn(async () => true);
  const ingest = { status: jest.fn((): IngestStatus => ({ state: 'live', lag: 0 })) };
  const moduleRef = await Test.createTestingModule({
    imports: [TerminusModule.forRoot({ logger: false })],
    providers: [
      LivelinessService,
      { provide: ClickHouseService, useValue: { ping } },
      { provide: SyncerConfig, useValue: { maxLagHealthy: MAX_LAG } },
      ...(opts.withIngest ? [{ provide: INGEST_STATUS, useValue: ingest }] : []),
    ],
  }).compile();
  return { service: moduleRef.get(LivelinessService), ping, ingest };
}

describe('LivelinessService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('without an ingest status provider', () => {
    it('is healthy while ClickHouse answers the ping', async () => {
      const { service } = await setup({ withIngest: false });
      const result = await service.livelinessCheck();
      expect(result.status).toBe('ok');
      expect(result.info).toHaveProperty('clickhouse');
      expect(result.info).not.toHaveProperty('ingest');
    });

    it('is unhealthy (503) when the ClickHouse ping fails', async () => {
      const { service, ping } = await setup({ withIngest: false });
      ping.mockResolvedValue(false);
      await expect(service.livelinessCheck()).rejects.toMatchObject({ status: 503 });
    });

    it('is unhealthy (503) when the ClickHouse ping throws', async () => {
      const { service, ping } = await setup({ withIngest: false });
      ping.mockRejectedValue(new Error('connect ECONNREFUSED'));
      await expect(service.livelinessCheck()).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('with an ingest status provider', () => {
    it('reports the ingest status when it is healthy', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'live', lag: 3 });
      const result = await service.livelinessCheck();
      expect(result.status).toBe('ok');
      expect(result.info?.ingest).toMatchObject({ status: 'up', state: 'live', lag: 3 });
    });

    it('tolerates a lag above the threshold for up to 60 s', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'catching_up', lag: MAX_LAG + 1 });
      await expect(service.livelinessCheck()).resolves.toMatchObject({ status: 'ok' });
      jest.advanceTimersByTime(MINUTE);
      await expect(service.livelinessCheck()).resolves.toMatchObject({ status: 'ok' });
    });

    it('is unhealthy (503) once the lag has stayed above the threshold for more than 60 s', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'catching_up', lag: MAX_LAG + 1 });
      await service.livelinessCheck();
      jest.advanceTimersByTime(MINUTE + 1);
      await expect(service.livelinessCheck()).rejects.toMatchObject({ status: 503 });
    });

    it('does not count a lag that is exactly the threshold', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'live', lag: MAX_LAG });
      await service.livelinessCheck();
      jest.advanceTimersByTime(10 * MINUTE);
      await expect(service.livelinessCheck()).resolves.toMatchObject({ status: 'ok' });
    });

    it('starts the 60 s window again after the lag dropped to the threshold', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'catching_up', lag: MAX_LAG + 5 });
      await service.livelinessCheck();
      jest.advanceTimersByTime(50_000);
      ingest.status.mockReturnValue({ state: 'live', lag: 0 });
      await service.livelinessCheck();
      jest.advanceTimersByTime(50_000);
      ingest.status.mockReturnValue({ state: 'catching_up', lag: MAX_LAG + 5 });
      await expect(service.livelinessCheck()).resolves.toMatchObject({ status: 'ok' });
      jest.advanceTimersByTime(MINUTE + 1);
      await expect(service.livelinessCheck()).rejects.toMatchObject({ status: 503 });
    });

    it('does not report a lag the runner has not measured yet as unhealthy', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'starting' });
      await service.livelinessCheck();
      jest.advanceTimersByTime(10 * MINUTE);
      await expect(service.livelinessCheck()).resolves.toMatchObject({ status: 'ok' });
    });

    it('reports the age of the last commit in seconds', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'live', lag: 1, lastCommitAt: Date.now() / 1000 - 42.4 });
      const result = await service.livelinessCheck();
      expect(result.info?.ingest).toMatchObject({ status: 'up', state: 'live', lag: 1, last_commit_age: 42 });
    });

    it('leaves the last commit age out before the first commit', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'starting' });
      const result = await service.livelinessCheck();
      expect(result.info?.ingest).not.toHaveProperty('last_commit_age');
    });

    it('reports a recovery that is stuck, without failing on it alone', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'catching_up', lag: 2, recovering: true, error: 'not quiescent' });
      const result = await service.livelinessCheck();
      expect(result.info?.ingest).toMatchObject({ status: 'up', recovering: true, error: 'not quiescent' });
    });

    it('is unhealthy (503) at once when the runner halted', async () => {
      const { service, ingest } = await setup({ withIngest: true });
      ingest.status.mockReturnValue({ state: 'halted', lag: 0 });
      await expect(service.livelinessCheck()).rejects.toMatchObject({ status: 503 });
    });

    it('is unhealthy (503) when ClickHouse is down even though ingest looks fine', async () => {
      const { service, ping } = await setup({ withIngest: true });
      ping.mockResolvedValue(false);
      await expect(service.livelinessCheck()).rejects.toMatchObject({ status: 503 });
    });
  });
});
