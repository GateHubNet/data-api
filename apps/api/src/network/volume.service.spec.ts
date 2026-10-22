import { ClickHouseService, livePeriodsOf, RatesService, VOLUME_METRICS } from '@gatehub/data-api-shared';
import { VolumeService } from './volume.service';

/** A ClickHouse that answers no row and keeps the statements it was asked. */
function fakeClickHouse() {
  const query = jest.fn(async (_sql: string, _params?: Record<string, unknown>): Promise<unknown[]> => []);
  return { ch: { query } as unknown as ClickHouseService, query };
}

describe('VolumeService', () => {
  describe('live', () => {
    const service = (ch: ClickHouseService): VolumeService =>
      new VolumeService(ch, { nativeCurrency: 'XRP' } as unknown as RatesService);

    const cases = VOLUME_METRICS.flatMap((metric) => livePeriodsOf(metric).map((period) => [metric, period] as const));

    it.each(cases)('%s / %s: reads fees_est_f only for the AMM volume of the day', async (metric, period) => {
      const { ch, query } = fakeClickHouse();
      await service(ch).live({ metric, period });
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(params).toEqual({ metric, period });
      if (metric === 'amm_volume' && period === 'day') {
        expect(sql).toMatch(/converted_f, fees_est_f,\s+toUnixTimestamp\(start_time\)/);
      } else {
        // the one set that has estimates is the only read that depends on migration 004
        expect(sql).not.toContain('fees_est_f');
        expect(sql).toMatch(/converted_f,\s+toUnixTimestamp\(start_time\)/);
      }
    });

    it('covers the twelve live sets', () => {
      expect(cases).toHaveLength(12);
      expect(cases).toContainEqual(['amm_volume', 'day']);
    });
  });
});
