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

    it('covers the fifteen live sets', () => {
      expect(cases).toHaveLength(15);
      expect(cases).toContainEqual(['amm_volume', 'day']);
      expect(cases).toContainEqual(['nft_volume', '30day']);
    });
  });

  describe('the count of the row', () => {
    const service = (ch: ClickHouseService): VolumeService =>
      new VolumeService(ch, { nativeCurrency: 'XRP' } as unknown as RatesService);
    const ISSUER = 'rLULtFk9Wi6BURPLNsGkoQrBSLoY8F5Cgz';

    /** A stored row of a set (the sentinel when `component` is empty): what `volume_live` and `volume_daily` hold. */
    const row = (component: string, count: number, extra: Record<string, unknown> = {}) => ({
      component,
      base_currency: component === '' ? '' : 'XRP',
      base_issuer: '',
      counter_currency: '',
      counter_issuer: '',
      amount: component === '' ? '0' : '10',
      count,
      converted_f: component === '' ? 0 : Number(extra.amount ?? 10),
      ...extra,
    });

    /** A ClickHouse that answers the live read with `live`, the buckets with `buckets` and the days with `days`. */
    function stubbed(answers: { live?: unknown[]; buckets?: string[]; days?: unknown[] }) {
      const query = jest.fn(async (sql: string): Promise<unknown[]> => {
        if (sql.includes('GROUP BY bucket')) return (answers.buckets ?? []).map((bucket) => ({ bucket }));
        if (sql.includes('day_text')) return answers.days ?? [];
        return answers.live ?? [];
      });
      return { ch: { query } as unknown as ClickHouseService, query };
    }

    const live = [
      row('', 1290, { start_time: 1_792_858_000, end_time: 1_792_944_400 }),
      row(`${ISSUER}/1`, 412, { start_time: 1_792_858_000, end_time: 1_792_944_400 }),
    ];

    it("live nft_volume: the count of the row is the sentinel's (every sale), not the sum of the components (412)", async () => {
      const { ch } = stubbed({ live });
      const [volume] = await service(ch).live({ metric: 'nft_volume', period: 'day' });
      expect(volume.count).toBe(1290);
      expect(volume.components).toEqual([
        { issuer: ISSUER, taxon: 1, count: 412, amount: '10', rate: '1.0000000', converted_amount: '10' },
      ]);
    });

    it('live of the payment volume is the sum of the components, the sentinel (0) left out: unchanged', async () => {
      const { ch } = stubbed({ live });
      const [volume] = await service(ch).live({ metric: 'payment_volume', period: 'day' });
      expect(volume.count).toBe(412);
    });

    it('a day of no sales is a row with the count 0 and no component: only its sentinel', async () => {
      const { ch } = stubbed({ live: [row('', 0, { start_time: 1_792_858_000, end_time: 1_792_944_400 })] });
      const [volume] = await service(ch).live({ metric: 'nft_volume', period: '7day' });
      expect([volume.count, volume.components]).toEqual([0, []]);
    });

    it('a sale with no rate is in the count of the day and in no component: the sentinel counts 5, the component 3', async () => {
      const { ch } = stubbed({
        live: [row('', 5, { start_time: 1, end_time: 2 }), row(ISSUER, 3, { start_time: 1, end_time: 2 })],
      });
      const [volume] = await service(ch).live({ metric: 'nft_volume', period: 'day' });
      expect([volume.count, (volume.components[0] as { count: number }).count]).toEqual([5, 3]);
    });

    describe('history', () => {
      // 2026-03-02 (a Monday) to 2026-03-04: three days of one week
      const days = [
        { day_text: '2026-03-02', ...row('', 5) },
        { day_text: '2026-03-02', ...row(`${ISSUER}/1`, 2, { amount: '3' }) },
        { day_text: '2026-03-03', ...row('', 7) },
        { day_text: '2026-03-03', ...row(`${ISSUER}/1`, 1, { amount: '4' }) },
        { day_text: '2026-03-04', ...row('', 0) },
      ];
      const query = (interval: 'day' | 'week') => ({
        metric: 'nft_volume' as const,
        interval,
        start: new Date('2026-03-02T00:00:00Z'),
        endExclusive: new Date('2026-03-05T00:00:00Z'),
        limit: 10,
      });

      it('a bucket of days adds up their sentinels: a week of 5, 7 and 0 sales is 12, its components 3', async () => {
        const { ch } = stubbed({ buckets: ['2026-03-02'], days });
        const { rows } = await service(ch).history(query('week'));
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(12);
        expect(rows[0].components).toEqual([
          { issuer: ISSUER, taxon: 1, count: 3, amount: '7', rate: '1.0000000', converted_amount: '7' },
        ]);
        expect(rows[0].total).toBe('7');
      });

      it('a day is its own sentinel: the rows of the days are 5, 7 and 0', async () => {
        const { ch } = stubbed({ buckets: ['2026-03-02', '2026-03-03', '2026-03-04'], days });
        const { rows } = await service(ch).history(query('day'));
        expect(rows.map((r) => r.count)).toEqual([5, 7, 0]);
        expect(rows.map((r) => r.components.length)).toEqual([1, 1, 0]);
      });

      it('the other metrics count their components, whatever their sentinels say', async () => {
        const { ch } = stubbed({ buckets: ['2026-03-02'], days });
        const { rows } = await service(ch).history({ ...query('week'), metric: 'payment_volume' });
        expect(rows[0].count).toBe(3);
      });
    });
  });
});
