import { ClickHouseService, Table } from '@gatehub/data-api-shared';

/**
 * The fakes and the times the unit specs of the aggregator share (`aggregator.service.spec.ts` and the specs of the AMM job
 * runners): a ClickHouse that answers what the service itself asks, a quiet logger, and the instant the ticks run at.
 */

export const HOUR = 3600;
export const DAY = 86_400;
export const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 19) + 'Z';
export const unix = (text: string): number => Date.parse(text) / 1000;

/** 2026-10-16T12:34:56Z */
export const NOW = new Date('2026-10-16T12:34:56Z');
export const NOW_SECONDS = NOW.getTime() / 1000;
/** 2026-10-16T10:00:00Z: the hour of now - 2h. */
export const LOOKBACK = unix('2026-10-16T10:00:00Z');
/** 2026-10-16T13:00:00Z: the hour after now. */
export const AFTER_NOW = unix('2026-10-16T13:00:00Z');

export const QUIET = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

export interface DirtyRow {
  from: number;
  to: number;
  /** Milliseconds. */
  created: number;
}

/**
 * A ClickHouse with the things the service asks it: the hours of `stats_hourly` (newest first), the close times of the
 * ledgers (ascending, as their indexes are), and the `agg_dirty` queue (with the semantics of the real table: reads give the
 * newest row of a key, oldest first; the DELETE takes a key and `created_at <= created`; the INSERT adds a row).
 */
export class FakeClickHouse {
  /** The newest hour of `stats_hourly` that has ledgers; shorthand for one row of `statsRows`. */
  watermark?: number;
  /** Rows of `stats_hourly`, newest hour first; replaces `watermark` when set. */
  statsRows?: Array<{ hour: number; ledger_count: number }>;
  /** The close times of the ledgers, ascending. */
  closes: number[] = [];
  dirty: DirtyRow[] = [];
  readonly sql: string[] = [];
  readonly params: Array<Record<string, unknown>> = [];

  /** The close time of the newest ledger; shorthand for `closes = [it]`. */
  set latestClose(closed: number | undefined) {
    this.closes = closed === undefined ? [] : [closed];
  }

  query = jest.fn(async (sql: string, params: Record<string, unknown> = {}): Promise<unknown[]> => {
    this.sql.push(sql);
    this.params.push(params);
    if (sql.includes(`FROM ${Table.StatsHourly}`)) {
      const rows = this.statsRows ?? (this.watermark === undefined ? [] : [{ hour: this.watermark, ledger_count: 1 }]);
      return rows
        .filter((r) => r.hour < Number(params.before))
        .sort((a, b) => b.hour - a.hour)
        .slice(0, Number(params.n))
        .map((r) => ({ hour_start: r.hour, ledger_count: r.ledger_count }));
    }
    if (sql.includes(`FROM ${Table.Ledgers}`)) {
      if (sql.includes('DESC')) {
        return this.closes.length === 0 ? [] : [{ closed: this.closes[this.closes.length - 1] }];
      }
      const found = sql.includes('close_time >=') ? this.closes.find((c) => c >= Number(params.from)) : this.closes[0];
      return found === undefined ? [] : [{ closed: found }];
    }
    if (sql.includes(`FROM ${Table.AggDirty}`)) {
      const newest = new Map<string, DirtyRow>();
      for (const row of this.dirty) {
        const key = `${row.from}-${row.to}`;
        const seen = newest.get(key);
        if (!seen || row.created > seen.created) newest.set(key, row);
      }
      return [...newest.values()]
        .sort((a, b) => a.created - b.created || a.from - b.from || a.to - b.to)
        .slice(0, Number(params.limit))
        .map((r) => ({ from_hour: r.from, to_hour: r.to, created_ms: r.created }));
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  async queryOne(sql: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return (await this.query(sql, params))[0];
  }

  command = jest.fn(async (sql: string, params: Record<string, unknown> = {}, _options?: unknown): Promise<void> => {
    this.sql.push(sql);
    if (sql.startsWith(`DELETE FROM ${Table.AggDirty}`)) {
      this.dirty = this.dirty.filter(
        (r) => !(r.from === params.from && r.to === params.to && r.created <= Number(params.created)),
      );
    } else if (sql.startsWith(`INSERT INTO ${Table.AggDirty}`)) {
      this.dirty.push({ from: Number(params.from), to: Number(params.to), created: Number(params.created) });
    } else {
      throw new Error(`unexpected command: ${sql}`);
    }
  });

  asService(): ClickHouseService {
    return this as unknown as ClickHouseService;
  }
}
